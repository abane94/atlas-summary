import { chromeConnectHint, withChatGptPage } from "../lib/browser.js";
import {
  DATE_RE,
  PIPELINE_STEPS,
  PROCESS_STEPS,
  chunksNeedWork,
  formatSessionStatus,
  generateChunks,
  generateMerged,
  getSessionStatus,
  latestTranscriptDate,
  listDatedFolders,
  mergeNeedsWork,
  type PipelineStep,
} from "../lib/summarize.ts";
import { findDuplicateEntities, formatDedupReport, previewEntityTable, runInteractiveDedup } from "../lib/dedup-entities.ts";
import {
  backfillEntityTags,
  formatTagsBackfillReport,
  previewTagsEntityTable,
} from "../lib/tag-entities.ts";
import {
  generateVaultData,
  getVaultForcePreview,
  getVaultProgress,
  vaultNeedsWork,
} from "../lib/vault-data.ts";

const HELP = `
dnd-transcribe-summary

Local pipeline (ChatGPT via Chrome):
  transcripts/YYYY-MM-DD/{recap.md,transcript.md}
    → chunks    summaries/YYYY-MM-DD/summary-N.json
    → merge     summaries/YYYY-MM-DD/merged.json
    → vault     vault-data/log/*.json + vault-data/entities/*.json

Website markdown is generated on CI (lib/generate-markdown.ts), not here.

Usage:
  npm start                         Show this help and session status
  npm start -- status [date]
  npm start -- <date>               Chunks + merge (skips completed steps)
  npm start -- process [date]       Same as above (date defaults to latest)
  npm start -- chunks|merge|vault [date]
  npm start -- vault [date]         Vault for one date, or every session that still needs it
  npm start -- vault <date> --force Redo vault for a date (replace entity logs; requires date)
  npm start -- dedup                Find likely duplicate vault entities (not part of process)
  npm start -- dedup --interactive  Confirm duplicates, then AI-merge approved groups
  npm start -- tags                 Assign closed-catalog tags to existing vault entities

Options:
  --force            Redo selected steps even if output already exists
                     (vault: re-read merged.json, re-run AI, replace that date's
                     entity logs; delete entities that only had this date; requires a date)
  --from <step>      Start at chunks, merge, or vault (then continue)
  --only <step,...>  Run only these steps
  --with-vault       Include vault after merge (off by default)
  --dry-run          Print what would run, without calling ChatGPT
  --interactive      For dedup: review each group and merge approved ones
  --help, -h         Show this help

Examples:
  npm run chrome:debug
  npm start -- 2026-08-17 --dry-run
  npm start -- 2026-08-17 --only merge
  npm start -- 2026-08-17 --with-vault
  npm start -- vault 2026-08-17
  npm start -- vault 2026-08-17 --force
  npm start -- 2026-08-17 --only chunks --force
  npm start -- dedup
  npm start -- dedup --dry-run
  npm start -- dedup --interactive
  npm start -- dedup --interactive --dry-run
  npm start -- tags
  npm start -- tags --dry-run
`.trim();

function rethrowChromeHint(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (/ECONNREFUSED|ERR_CONNECTION_REFUSED|fetch failed|webSocket URL/i.test(message)) {
    throw new Error(chromeConnectHint());
  }
  throw error;
}

interface ParsedArgs {
  help: boolean;
  force: boolean;
  dryRun: boolean;
  withVault: boolean;
  interactive: boolean;
  command: string;
  date?: string;
  from?: PipelineStep;
  only?: PipelineStep[];
}

function isStep(value: string): value is PipelineStep {
  return (PIPELINE_STEPS as readonly string[]).includes(value);
}

function parseStepsList(value: string): PipelineStep[] {
  const steps = value.split(",").map((part) => part.trim()).filter(Boolean);
  for (const step of steps) {
    if (!isStep(step)) {
      throw new Error(`Unknown step "${step}". Use: ${PIPELINE_STEPS.join(", ")}`);
    }
  }
  return steps as PipelineStep[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Set<string>();
  const options: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      flags.add("help");
    } else if (arg === "--force") {
      flags.add("force");
    } else if (arg === "--dry-run") {
      flags.add("dry-run");
    } else if (arg === "--interactive") {
      flags.add("interactive");
    } else if (arg === "--with-vault") {
      flags.add("with-vault");
    } else if (arg === "--from" || arg === "--only") {
      const value = argv[++i];
      if (!value || value.startsWith("-")) {
        throw new Error(`${arg} requires a value`);
      }
      options[arg.slice(2)] = value;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  const commands = new Set([
    "process",
    "chunks",
    "merge",
    "vault",
    "dedup",
    "tags",
    "status",
    "help",
  ]);

  let command = "help";
  let date: string | undefined;
  if (positional.length === 0) {
    command = "help";
  } else if (DATE_RE.test(positional[0]) || positional[0] === "latest") {
    command = "process";
    date = positional[0];
    if (positional[1]) {
      throw new Error(`Unexpected argument: ${positional[1]}`);
    }
  } else if (commands.has(positional[0])) {
    command = positional[0];
    date = positional[1];
    if (positional[2]) {
      throw new Error(`Unexpected argument: ${positional[2]}`);
    }
  } else {
    throw new Error(`Unknown command: ${positional[0]}`);
  }

  const from = options.from ? parseStepsList(options.from)[0] : undefined;
  const only = options.only ? parseStepsList(options.only) : undefined;
  if (from && only) {
    throw new Error("Use either --from or --only, not both");
  }
  if ((from || only) && command !== "process" && command !== "help") {
    throw new Error("--from / --only only apply to process");
  }

  return {
    help: flags.has("help") || command === "help",
    force: flags.has("force"),
    dryRun: flags.has("dry-run"),
    withVault: flags.has("with-vault"),
    interactive: flags.has("interactive"),
    command,
    date,
    from,
    only,
  };
}

function resolveDate(input: string | undefined, required: boolean): string | undefined {
  if (input && input !== "latest") {
    if (!DATE_RE.test(input)) {
      throw new Error(`Date must be YYYY-MM-DD (got "${input}")`);
    }
    return input;
  }
  const latest = latestTranscriptDate();
  if (!latest && required) {
    throw new Error(
      'No transcripts/YYYY-MM-DD folders found. Add recap.md and transcript.md under transcripts/<date>/ first.',
    );
  }
  return latest;
}

function stepsForProcess(args: ParsedArgs): PipelineStep[] {
  if (args.only) return args.only;
  const steps: PipelineStep[] = args.withVault
    ? [...PIPELINE_STEPS]
    : [...PROCESS_STEPS];
  if (args.from === "vault") return ["vault"];
  if (args.from) {
    const start = steps.indexOf(args.from);
    if (start === -1) {
      throw new Error(`Unknown step "${args.from}". Use: ${PIPELINE_STEPS.join(", ")}`);
    }
    return steps.slice(start);
  }
  return steps;
}

async function stepNeedsWork(
  step: PipelineStep,
  date: string,
  force: boolean,
): Promise<boolean> {
  if (step === "chunks") return chunksNeedWork(date, force);
  if (step === "merge") return mergeNeedsWork(date, force);
  return vaultNeedsWork(date, { force });
}

async function printStatus(date?: string): Promise<void> {
  const dates = date
    ? [date]
    : [...new Set([...listDatedFolders("transcripts"), ...listDatedFolders("summaries")])].sort();

  if (dates.length === 0) {
    console.log("No sessions found in transcripts/ or summaries/.");
    return;
  }

  console.log("Sessions:");
  for (const sessionDate of dates) {
    const status = getSessionStatus(sessionDate);
    let line = `  ${formatSessionStatus(status)}`;
    if (status.mergedJson) {
      const progress = await getVaultProgress(sessionDate);
      if (progress.entityTotal > 0) {
        line += `  entities ${progress.entityProcessed}/${progress.entityTotal}`;
      }
    }
    console.log(line);
  }
}

async function describeStep(step: PipelineStep, date: string, force = false): Promise<string> {
  if (step === "vault") {
    if (force) {
      const preview = await getVaultForcePreview(date);
      const progress = await getVaultProgress(date);
      const parts = [
        `replace ${preview.entityLogsToReplace} entity log${preview.entityLogsToReplace === 1 ? "" : "s"}`,
        `delete ${preview.entitiesToDelete} entit${preview.entitiesToDelete === 1 ? "y" : "ies"}`,
        preview.hasSessionLog ? "rewrite session log" : "write session log",
        `${progress.entityTotal} from merged.json`,
      ];
      return `${step} --force (${parts.join(", ")})`;
    }
    const progress = await getVaultProgress(date);
    const remaining = Math.max(0, progress.entityTotal - progress.entityProcessed);
    const log = progress.hasSessionLog ? "session log exists" : "no session log";
    return `${step} (${remaining} entit${remaining === 1 ? "y" : "ies"} to write, ${log})`;
  }
  return step;
}

async function runSelectedSteps(
  date: string,
  steps: PipelineStep[],
  force: boolean,
  dryRun = false,
): Promise<void> {
  const needed: PipelineStep[] = [];
  for (const step of steps) {
    if (await stepNeedsWork(step, date, force)) {
      needed.push(step);
    } else {
      console.log(`[${step}] already complete, skipping`);
    }
  }

  if (needed.length === 0) {
    console.log(`Nothing to do for ${date}. Use --force to redo a step.`);
    return;
  }

  const described: string[] = [];
  for (const step of needed) {
    described.push(await describeStep(step, date, force));
  }
  console.log(`${dryRun ? "Would run" : "Running"}: ${described.join(" → ")}`);
  if (dryRun) return;

  try {
    await withChatGptPage(async (page) => {
      for (const step of needed) {
        if (step === "chunks") await generateChunks(page, date, { force });
        else if (step === "merge") await generateMerged(page, date, { force });
        else await generateVaultData(page, "summaries", "vault-data", { date, force });
      }
    });
  } catch (error) {
    rethrowChromeHint(error);
  }
}

async function main(): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    console.error(`\n${HELP}`);
    process.exitCode = 1;
    return;
  }

  if (args.help) {
    console.log(HELP);
    console.log("");
    await printStatus();
    return;
  }

  if (args.command === "status") {
    const date = args.date ? resolveDate(args.date, true) : undefined;
    await printStatus(date);
    return;
  }

  if (args.command === "dedup") {
    if (args.date) {
      throw new Error("dedup does not take a session date");
    }
    if (args.interactive) {
      try {
        await runInteractiveDedup({ dryRun: args.dryRun });
      } catch (error) {
        rethrowChromeHint(error);
      }
      return;
    }
    if (args.dryRun) {
      console.log(await previewEntityTable());
      return;
    }
    try {
      await withChatGptPage(async (page) => {
        const result = await findDuplicateEntities(page);
        console.log(formatDedupReport(result));
      });
    } catch (error) {
      rethrowChromeHint(error);
    }
    return;
  }

  if (args.command === "tags") {
    if (args.date) {
      throw new Error("tags does not take a session date");
    }
    if (args.dryRun) {
      console.log(await previewTagsEntityTable());
      return;
    }
    try {
      await withChatGptPage(async (page) => {
        const result = await backfillEntityTags(page);
        console.log(formatTagsBackfillReport(result));
      });
    } catch (error) {
      rethrowChromeHint(error);
    }
    return;
  }

  if (args.command === "vault" && !args.date) {
    if (args.force) {
      throw new Error(
        "vault --force requires a session date, e.g. vault 2026-08-17 --force",
      );
    }
    const dates = listDatedFolders("summaries");
    const needed: string[] = [];
    for (const sessionDate of dates) {
      if (await vaultNeedsWork(sessionDate, { force: false })) {
        needed.push(sessionDate);
      }
    }
    if (needed.length === 0) {
      console.log(
        "All vault sessions are up to date. Use vault <date> --force to redo a session.",
      );
      return;
    }
    console.log(`Vault work needed for: ${needed.join(", ")}`);
    if (args.dryRun) return;
    try {
      await withChatGptPage(async (page) => {
        await generateVaultData(page, "summaries", "vault-data", {});
      });
    } catch (error) {
      rethrowChromeHint(error);
    }
    return;
  }

  const date = resolveDate(args.date, true);
  if (!date) {
    throw new Error("A session date is required");
  }

  if (args.date !== date) {
    console.log(`Using session ${date}`);
  }

  const steps: PipelineStep[] =
    args.command === "process" ? stepsForProcess(args) : [args.command as PipelineStep];

  await runSelectedSteps(date, steps, args.force, args.dryRun);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

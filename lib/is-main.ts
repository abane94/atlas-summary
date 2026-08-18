import path from "node:path";
import { pathToFileURL } from "node:url";

/** True when this module was the process entrypoint (`node this-file.ts`). */
export function isDirectRun(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return metaUrl === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
}

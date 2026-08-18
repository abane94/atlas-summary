if (process.argv[1]?.includes("example.ts")) {
  console.warn("src/example.ts is deprecated; use: npm start -- <date>\n");
}
await import("./cli.ts");
export {};

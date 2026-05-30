#!/usr/bin/env bun
/** diagnose — inspect finance DB without touching it.
 *
 * Usage:
 *   bun run scripts/diagnose/diagnose.ts <command> [...args]
 *
 * Commands:
 *   networth <YYYY-MM-DD>      drill-down of net worth on a date
 *   symbol <SYMBOL>            every mention of a symbol across tables
 *   source <NAME>              what a data source contributes
 *   gaps [--min-txns N] [--min-value USD]
 *                              coverage audit (missing prices, orphan rows)
 *
 * All commands are read-only. No network, no ingest. */

const cmd = process.argv[2];
const rest = process.argv.slice(3);

async function main() {
  switch (cmd) {
    case "networth":  return (await import("./networth")).run(rest);
    case "symbol":    return (await import("./symbol")).run(rest);
    case "source":    return (await import("./source")).run(rest);
    case "gaps":      return (await import("./gaps")).run(rest);
    case "kubera-check": return (await import("./kubera-check")).run(rest);
    case "composition": return (await import("./composition")).run(rest);
    case undefined:
    case "-h":
    case "--help":
      console.log(`usage: diagnose <networth|symbol|source|gaps> [...]`);
      return 0;
    default:
      console.error(`unknown command: ${cmd}`);
      return 1;
  }
}

process.exit(await main());

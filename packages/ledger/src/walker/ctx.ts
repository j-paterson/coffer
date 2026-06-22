import type { Database } from "bun:sqlite";

/** Minimum context the walker needs. apps/server/src/ctx.ts:Ctx
 *  extends this so existing route handlers continue to compile. */
export interface LedgerCtx {
  db: Database;
  /** ISO-date "today". Production reads from system clock at startup;
   *  tests pin it to a fixture's as_of. */
  today: string;
}

/** Test-only Ctx factory. Opens a fresh :memory: SQLite, applies all
 *  migrations, returns a Ctx with a pinned `today`.
 *
 *  Tests construct one Ctx per test (or per `beforeEach`) so each test
 *  is fully isolated. The DB is closed when the test function returns
 *  (Bun cleans up :memory: handles automatically). */

import { openInMemoryDb } from "../src/db";
import type { Ctx } from "../src/ctx";

export function createTestCtx(today: string = "2026-04-27"): Ctx {
  return {
    db: openInMemoryDb(),
    today,
  };
}

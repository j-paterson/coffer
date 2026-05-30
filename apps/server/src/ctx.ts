/** Per-request execution context.
 *
 * Production: constructed once in index.ts, attached to every Hono
 * request via middleware, read by route handlers and lib functions.
 *
 * Tests: constructed in test/setup.ts with an in-memory database and
 * a pinned `today`, passed directly to library functions (route
 * handlers go through the same Hono pipeline).
 *
 * Library functions and route handlers MUST take Ctx (or a Database
 * pulled from it) as a parameter. They MUST NOT call db() directly —
 * the singleton has been removed. */

import type { LedgerCtx } from "@coffer/ledger/walker";

export interface Ctx extends LedgerCtx {}

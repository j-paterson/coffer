import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Operation } from "@coffer/ledger/runner";
import { manualCsvParser } from "../src/manual-csv";
import { ConsoleLogger } from "../src/types/logger";
import { ManualCsvConfig } from "../src/manual-csv/config";
import { buildContext } from "../src/context";

const FIXTURE = resolve(import.meta.dir, "fixtures/chase-export.csv");

const SILENT_SINK = { debug() {}, info() {}, warn() {}, error() {} };

describe("manualCsvParser snapshot", () => {
  test("emits the expected op stream for the chase fixture", async () => {
    const config = ManualCsvConfig.parse({
      account_id: "manual:chase-checking",
      files: [FIXTURE],
      columns: { date: "Posting Date", description: "Memo", amount: "Amount" },
      account: {
        display_name: "Chase Checking",
        institution: "Chase",
        type: "checking",
      },
    });
    const ctx = buildContext({
      config,
      logger: new ConsoleLogger(SILENT_SINK),
      now: () => new Date("2025-02-01T00:00:00Z"),
    });

    const ops: Operation[] = [];
    for await (const op of manualCsvParser.sync(ctx)) ops.push(op);

    // Strip the absolute fixture path from raw_event payloads/source_file
    // and from sync_warning scopes so the snapshot is portable.
    const portable = ops.map((op) => {
      if (op.kind === "raw_event") {
        const payload = (op.payload ?? {}) as Record<string, unknown>;
        return {
          ...op,
          source_file: "fixture",
          payload: { ...payload, file: "fixture" },
        };
      }
      if (op.kind === "sync_warning") {
        return { ...op, warning: { ...op.warning, scope: "fixture" } };
      }
      return op;
    });

    expect(portable).toMatchSnapshot();
  });
});

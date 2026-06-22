import { createHash } from "node:crypto";
import type { Operation } from "@coffer/ledger/runner";
import type { ParserContext } from "../types/parser";
import type { ManualCsvConfig } from "./config";
import { parseCsv } from "./csv";
import { parseDate } from "./date";

const SOURCE = "manual-csv";

function hashId(parts: (string | number)[]): string {
  const h = createHash("sha256");
  h.update(parts.join("|"));
  return h.digest("hex").slice(0, 16);
}

function indexOfColumn(header: string[], name: string): number {
  const idx = header.indexOf(name);
  if (idx < 0) {
    throw new Error(`manual-csv: column ${JSON.stringify(name)} missing from header [${header.join(", ")}]`);
  }
  return idx;
}

/** Yield the operations for one file. The caller emits the global
 *  account_discovery op once before the first file. */
export async function* opsForFile(
  filePath: string,
  config: ManualCsvConfig,
  ctx: ParserContext<ManualCsvConfig>,
): AsyncGenerator<Operation> {
  let text: string;
  try {
    text = await Bun.file(filePath).text();
  } catch (err) {
    yield {
      kind: "sync_warning",
      warning: {
        source: SOURCE,
        scope: filePath,
        message: `failed to read file: ${(err as Error).message}`,
      },
    };
    return;
  }
  let parsed;
  try {
    parsed = parseCsv(text);
  } catch (err) {
    yield {
      kind: "sync_warning",
      warning: {
        source: SOURCE,
        scope: filePath,
        message: `failed to parse CSV: ${(err as Error).message}`,
      },
    };
    return;
  }

  let dateIdx: number, descriptionIdx: number, amountIdx: number;
  try {
    dateIdx        = indexOfColumn(parsed.header, config.columns.date);
    descriptionIdx = indexOfColumn(parsed.header, config.columns.description);
    amountIdx      = indexOfColumn(parsed.header, config.columns.amount);
  } catch (err) {
    yield {
      kind: "sync_warning",
      warning: {
        source: SOURCE,
        scope: filePath,
        message: (err as Error).message,
      },
    };
    return;
  }

  for (const row of parsed.rows) {
    const rawDate = row.fields[dateIdx] ?? "";
    const rawDesc = (row.fields[descriptionIdx] ?? "").trim();
    const rawAmt  = row.fields[amountIdx] ?? "";

    let date: string;
    try {
      date = parseDate(rawDate, config.date_format);
    } catch (err) {
      yield {
        kind: "sync_warning",
        warning: {
          source: SOURCE,
          scope: filePath,
          message: `skipped row ${row.lineNumber}: ${(err as Error).message}`,
          detail: { line: row.lineNumber, fields: row.fields },
        },
      };
      continue;
    }

    const amountNum = Number(rawAmt);
    if (!Number.isFinite(amountNum)) {
      yield {
        kind: "sync_warning",
        warning: {
          source: SOURCE,
          scope: filePath,
          message: `skipped row ${row.lineNumber}: amount ${JSON.stringify(rawAmt)} is not numeric`,
          detail: { line: row.lineNumber, fields: row.fields },
        },
      };
      continue;
    }

    const internalAmount =
      config.sign_convention === "debits-positive" ? -amountNum : amountNum;

    const externalId = hashId([
      config.account_id,
      date,
      rawDesc,
      // Round to 4 decimals so trivial float reformatting between syncs
      // doesn't change the hash.
      internalAmount.toFixed(4),
      row.lineNumber,
    ]);

    yield {
      kind: "raw_event",
      source: SOURCE,
      external_id: externalId,
      payload: {
        file: filePath,
        line: row.lineNumber,
        date,
        description: rawDesc,
        amount: internalAmount,
        currency: config.account.currency,
      },
      source_file: filePath,
    };

    yield {
      kind: "one_sided",
      draft: {
        date,
        description: rawDesc.length > 0 ? rawDesc : null,
        account_id: config.account_id,
        amount: internalAmount,
        currency: config.account.currency,
        derived_by: SOURCE,
      },
      event_refs: [{ source: SOURCE, external_id: externalId }],
    };
  }

  ctx.logger.debug("manual-csv: file complete", { file: filePath, rows: parsed.rows.length });
}

/** Top-level sync generator the Parser exposes. Emits one
 *  account_discovery op, then concatenates per-file streams. */
export async function* syncManualCsv(
  ctx: ParserContext<ManualCsvConfig>,
): AsyncGenerator<Operation> {
  const c = ctx.config;
  yield {
    kind: "account_discovery",
    draft: {
      id: c.account_id,
      display_name: c.account.display_name,
      institution: c.account.institution,
      type: c.account.type,
      currency: c.account.currency,
      mode: "manual",
    },
  };

  for (const file of c.files) {
    yield* opsForFile(file, c, ctx);
  }
}

import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../db";
import { attachReceipts } from "../attachReceipts";
import type { TransactionRow } from "../../../../../packages/shared/types";

test("the zeroed category-holding item of a receipt-itemized txn is not listed", () => {
  const db = new Database(":memory:");
  applyMigrations(db);
  db.prepare(`INSERT INTO transactions_v2 (id, date, description, derived_by) VALUES (1, '2026-04-01', 'SHOP', 'ingest')`).run();
  db.prepare(`INSERT INTO emails (id, received_at, from_addr, subject, raw_path) VALUES ('m', '2026-04-01', 'a@example.com', 'Receipt', 'x.eml')`).run();
  db.prepare(`INSERT INTO transaction_items (line_no, name, line_total, category, category_source, transaction_v2_id) VALUES (1, 'SHOP', 0, 'Business', 'user', 1)`).run();
  db.prepare(`INSERT INTO transaction_items (email_id, line_no, name, line_total, category, transaction_v2_id) VALUES ('m', 1, 'Lamp', -30, 'Business', 1)`).run();
  const txns = [{ id: "1" }] as TransactionRow[];
  attachReceipts({ db, today: "2026-04-30" }, txns);
  expect(txns[0]!.items?.map((i) => i.name)).toEqual(["Lamp"]);
});

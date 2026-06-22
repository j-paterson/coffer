import type { PriceProvider } from "../types/price-provider";
import type { V2Transaction } from "./client";

export interface WalkInput {
  txns: V2Transaction[];
  symbol: string;
  chain: string;
  contract_address: string;
  todayDate: string;
  todayQty: number | null;
  priceProvider: PriceProvider;
}

export type WalkWarning =
  | {
      scope: "price_lookup_failed";
      detail: { symbol: string; as_of: string };
    }
  | {
      scope: "negative_balance";
      detail: { as_of: string; qty: number };
    };

export interface WalkSnapshot {
  as_of: string;
  qty: number;
  price_usd: number;
}

export interface WalkResult {
  snapshots: WalkSnapshot[];
  warnings: WalkWarning[];
}

export function walkWarningMessage(w: WalkWarning): string {
  switch (w.scope) {
    case "price_lookup_failed":
      return `No price for ${w.detail.symbol} on ${w.detail.as_of}`;
    case "negative_balance":
      return "Negative balance during walk";
  }
}

function dateFromIso(iso: string): string {
  return iso.slice(0, 10);
}

function shiftDay(yyyymmdd: string, deltaDays: number): string {
  const y = +yyyymmdd.slice(0, 4);
  const m = +yyyymmdd.slice(5, 7) - 1;
  const d = +yyyymmdd.slice(8, 10);
  const t = Date.UTC(y, m, d) + deltaDays * 86_400_000;
  const dt = new Date(t);
  const yy = dt.getUTCFullYear().toString().padStart(4, "0");
  const mm = (dt.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = dt.getUTCDate().toString().padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

export async function runQuantityWalk(input: WalkInput): Promise<WalkResult> {
  const { txns, symbol, chain, contract_address, todayDate, todayQty, priceProvider } = input;

  const sortedTxns = [...txns].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const deltaByDate = new Map<string, number>();
  for (const t of sortedTxns) {
    const d = dateFromIso(t.created_at);
    const v = parseFloat(t.amount.amount);
    deltaByDate.set(d, (deltaByDate.get(d) ?? 0) + v);
  }

  const snapshots: WalkSnapshot[] = [];
  const warnings: WalkWarning[] = [];

  let qty = 0;
  if (deltaByDate.size > 0) {
    const earliest = [...deltaByDate.keys()].sort()[0]!;
    let cursor = earliest;
    while (cursor <= todayDate) {
      qty += deltaByDate.get(cursor) ?? 0;
      if (qty < 0) {
        warnings.push({ scope: "negative_balance", detail: { as_of: cursor, qty } });
      } else if (qty > 0) {
        const px = await priceProvider.getPrice({ symbol, chain, contract_address, as_of: cursor });
        if (px == null) {
          warnings.push({ scope: "price_lookup_failed", detail: { symbol, as_of: cursor } });
        } else {
          snapshots.push({ as_of: cursor, qty, price_usd: px.price_usd });
        }
      }
      if (cursor === todayDate) break;
      cursor = shiftDay(cursor, 1);
    }
  }

  if (todayQty == null) return { snapshots, warnings };

  if (todayQty === 0) {
    const idx = snapshots.findIndex((s) => s.as_of === todayDate);
    if (idx >= 0) snapshots.splice(idx, 1);
    return { snapshots, warnings };
  }

  const px = await priceProvider.getPrice({ symbol, chain, contract_address, as_of: todayDate });
  if (px == null) {
    warnings.push({ scope: "price_lookup_failed", detail: { symbol, as_of: todayDate } });
    const idx = snapshots.findIndex((s) => s.as_of === todayDate);
    if (idx >= 0) snapshots.splice(idx, 1);
    return { snapshots, warnings };
  }

  const idx = snapshots.findIndex((s) => s.as_of === todayDate);
  const entry: WalkSnapshot = { as_of: todayDate, qty: todayQty, price_usd: px.price_usd };
  if (idx >= 0) snapshots[idx] = entry;
  else snapshots.push(entry);

  return { snapshots, warnings };
}

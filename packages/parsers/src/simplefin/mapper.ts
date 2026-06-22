import type { Operation } from "@coffer/ledger/runner";
import { makeExternalId } from "../shared/ids/external-id";
import type {
  SimpleFinAccount,
  SimpleFinAccountsResponse,
  SimpleFinTransaction,
} from "./client";
import type { SimpleFinConfig } from "./config";

const SOURCE = "simplefin";

export interface MapSimpleFinResponsesOpts {
  responses: SimpleFinAccountsResponse[];   // ordered: oldest window first
  asOf: string;                             // ISO date for as_of fields
  overrides: SimpleFinConfig["account_overrides"];
}

function institutionOf(acct: SimpleFinAccount): string {
  return acct.org?.name ?? acct.org?.domain ?? "Unknown";
}

function txnTime(t: SimpleFinTransaction): number {
  return t.posted ?? t.transacted_at ?? 0;
}

function isoDateUtc(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

function emitHolding(
  sfId: string,
  asOf: string,
  hold: import("./client").SimpleFinHolding,
  ops: Operation[],
): void {
  const haveSymbol = !!hold.symbol?.trim();
  const haveDesc   = !!hold.description?.trim();
  if (!haveSymbol && !haveDesc) {
    ops.push({
      kind: "sync_warning",
      warning: {
        source: SOURCE,
        scope: sfId,
        message: "holding missing symbol and description; emitted as UNKNOWN",
      },
    });
  }
  const symbol = (hold.symbol?.trim() || hold.description?.trim().slice(0, 32) || "UNKNOWN");
  const qty   = Number(hold.shares ?? 0);
  const value = parseFloat(hold.market_value ?? "0");
  const price = Number.isFinite(qty) && qty > 0 ? value / qty : null;

  const externalId = makeExternalId({
    source: SOURCE,
    account: sfId,
    intrinsic: `hold:${symbol}:${asOf}`,
    fallback: () => `hold:${symbol}:${asOf}`,
  });
  ops.push({
    kind: "raw_event",
    source: SOURCE,
    external_id: externalId,
    payload: {
      account_id: sfId,
      symbol,
      shares: hold.shares ?? null,
      market_value: hold.market_value ?? null,
      cost_basis: hold.cost_basis ?? null,
      description: hold.description ?? null,
      currency: hold.currency ?? null,
      as_of: asOf,
    },
  });
  ops.push({
    kind: "position_snapshot",
    draft: {
      account_id: `${SOURCE}:${sfId}`,
      symbol,
      chain: null,
      contract_address: null,
      as_of: asOf,
      qty,
      price_usd: price,
      source: SOURCE,
    },
    event_refs: [{ source: SOURCE, external_id: externalId }],
  });
}

function inferType(acct: SimpleFinAccount): string {
  const name = (acct.name ?? "").toLowerCase();
  const balance = parseFloat(acct.balance ?? "0");
  if (name.includes("wallet") || name.includes("staked"))  return "crypto";
  if (Number.isFinite(balance) && balance < 0) return "credit";
  if (name.includes("saving"))                  return "savings";
  if (name.includes("401") || name.includes("ira") || name.includes("retire")) return "retirement";
  if (name.includes("invest") || name.includes("brokerage")) return "brokerage";
  return "checking";
}

function emitAccount(
  acct: SimpleFinAccount,
  asOf: string,
  overrides: SimpleFinConfig["account_overrides"],
  ops: Operation[],
): void {
  const o = overrides[acct.id] ?? {};
  const ledgerId = `${SOURCE}:${acct.id}`;

  ops.push({
    kind: "account_discovery",
    draft: {
      id: ledgerId,
      display_name: o.display_name ?? acct.name,
      institution:  o.institution ?? institutionOf(acct),
      type:         o.type ?? inferType(acct),
      currency:     acct.currency ?? "USD",
      mode: "live",
      external_id: acct.id,
      source: SOURCE,
    },
  });

  const balExternalId = makeExternalId({
    source: SOURCE,
    account: acct.id,
    intrinsic: `balance:${asOf}`,
    fallback: () => `balance:${asOf}`,
  });
  ops.push({
    kind: "raw_event",
    source: SOURCE,
    external_id: balExternalId,
    payload: {
      account_id: acct.id,
      balance: acct.balance,
      currency: acct.currency ?? "USD",
      as_of: asOf,
    },
  });
  ops.push({
    kind: "assertion",
    draft: {
      account_id: ledgerId,
      as_of: asOf,
      expected_usd: parseFloat(acct.balance),
      source: SOURCE,
    },
    event_refs: [{ source: SOURCE, external_id: balExternalId }],
  });

  const txns = [...(acct.transactions ?? [])].sort((a, b) => {
    const dt = txnTime(a) - txnTime(b);
    if (dt !== 0) return dt;
    return (a.id ?? "").localeCompare(b.id ?? "");
  });
  let datelessCount = 0;
  for (const t of txns) {
    if (emitTxn(acct.id, acct.currency ?? "USD", t, ops) === "dateless") datelessCount++;
  }
  if (datelessCount > 0) {
    ops.push({
      kind: "sync_warning",
      warning: {
        source: SOURCE,
        scope: acct.id,
        message: `${datelessCount} transaction(s) skipped — no posted date yet (likely pending; SimpleFIN omits the date until they clear)`,
      },
    });
  }

  const holdings = [...(acct.holdings ?? [])].sort((a, b) => {
    const sa = (a.symbol?.trim() || a.description?.trim().slice(0, 32) || "UNKNOWN");
    const sb = (b.symbol?.trim() || b.description?.trim().slice(0, 32) || "UNKNOWN");
    return sa.localeCompare(sb);
  });
  for (const h of holdings) emitHolding(acct.id, asOf, h, ops);
}

function emitTxn(
  sfId: string,
  currency: string,
  t: SimpleFinTransaction,
  ops: Operation[],
): "dateless" | "kept" {
  const time = txnTime(t);
  // No posted/transacted_at yet — almost always a pending transaction
  // SimpleFIN hasn't dated. Skip here; the caller emits one aggregated
  // warning per account instead of one per txn.
  if (time === 0) return "dateless";
  const amount = parseFloat(t.amount);
  if (!Number.isFinite(amount)) {
    ops.push({
      kind: "sync_warning",
      warning: {
        source: SOURCE,
        scope: sfId,
        message: `txn ${JSON.stringify(t.id ?? "")} amount ${JSON.stringify(t.amount)} is not numeric; skipped`,
      },
    });
    return "kept";
  }
  const ledgerId = `${SOURCE}:${sfId}`;
  const externalId = makeExternalId({
    source: SOURCE,
    account: sfId,
    intrinsic: t.id,
    fallback: () => `${time}|${t.amount}|${t.description ?? ""}`,
  });
  const date = isoDateUtc(time);

  ops.push({
    kind: "raw_event",
    source: SOURCE,
    external_id: externalId,
    payload: {
      account_id: sfId,
      id: t.id,
      posted: time,
      amount: t.amount,
      description: t.description ?? "",
      pending: t.pending ?? false,
    },
  });
  ops.push({
    kind: "one_sided",
    draft: {
      date,
      description: t.description ?? null,
      account_id: ledgerId,
      amount,
      currency,
      derived_by: SOURCE,
    },
    event_refs: [{ source: SOURCE, external_id: externalId }],
  });
  return "kept";
}

interface MergedAccount {
  snapshot: SimpleFinAccount;
  txnsById: Map<string, SimpleFinTransaction>;
}

function mergeWindows(responses: SimpleFinAccountsResponse[]): {
  accounts: MergedAccount[];
  errlist: string[];
} {
  const snapshots = new Map<string, SimpleFinAccount>();
  const txns = new Map<string, Map<string, SimpleFinTransaction>>();

  for (const r of responses) {
    for (const acct of r.accounts) {
      const id = acct.id;
      if (!id) continue;
      snapshots.set(id, acct);
      const bucket = txns.get(id) ?? new Map<string, SimpleFinTransaction>();
      for (const t of (acct.transactions ?? [])) {
        if (t.id != null && !bucket.has(t.id)) bucket.set(t.id, t);
      }
      txns.set(id, bucket);
    }
  }

  const seenErr = new Set<string>();
  const errlist: string[] = [];
  for (const r of responses) {
    for (const msg of (r.errlist ?? [])) {
      if (!seenErr.has(msg)) {
        seenErr.add(msg);
        errlist.push(msg);
      }
    }
  }

  const accounts: MergedAccount[] = [];
  for (const [id, snapshot] of snapshots) {
    accounts.push({ snapshot, txnsById: txns.get(id) ?? new Map() });
  }
  return { accounts, errlist };
}

export function mapSimpleFinResponses(opts: MapSimpleFinResponsesOpts): Operation[] {
  const { responses, asOf, overrides } = opts;
  const ops: Operation[] = [];
  if (responses.length === 0) return ops;

  // Preserve Task 6 missing-id warning behavior, sourced from newest window.
  const newest = responses[responses.length - 1]!;
  for (const acct of newest.accounts) {
    if (!acct.id) {
      ops.push({
        kind: "sync_warning",
        warning: { source: SOURCE, scope: "account", message: "account missing id; skipped" },
      });
    }
  }

  const merged = mergeWindows(responses);
  merged.accounts.sort((a, b) => a.snapshot.id.localeCompare(b.snapshot.id));
  for (const m of merged.accounts) {
    const acctForEmit: SimpleFinAccount = {
      ...m.snapshot,
      transactions: [...m.txnsById.values()],
    };
    emitAccount(acctForEmit, asOf, overrides, ops);
  }

  for (const msg of merged.errlist) {
    ops.push({
      kind: "sync_warning",
      warning: { source: SOURCE, scope: "errlist", message: msg },
    });
  }

  return ops;
}

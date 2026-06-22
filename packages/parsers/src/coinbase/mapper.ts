import type { Operation, PositionSnapshotDraft } from "@coffer/ledger/runner";
import type { V3Account, V2Account, V2Transaction } from "./client";

export function lowerName(name: string): string {
  return name.trim().toLowerCase();
}

export function walletJoinKey(name: string, currency: string): string {
  return `${lowerName(name)}|${currency}`;
}

export function defaultChainFor(
  currency: string,
  configChainMap: Record<string, string>,
  builtIn: Record<string, string>,
): string {
  return configChainMap[currency] ?? builtIn[currency] ?? "";
}

export function rawEventFromV3Account(
  acct: V3Account,
  todayDate: string,
): Extract<Operation, { kind: "raw_event" }> {
  return {
    kind: "raw_event",
    source: "coinbase",
    external_id: `coinbase:v3-account:${acct.uuid}:${todayDate}`,
    payload: acct,
  };
}

export function rawEventFromV2Account(
  acct: V2Account,
  todayDate: string,
): Extract<Operation, { kind: "raw_event" }> {
  return {
    kind: "raw_event",
    source: "coinbase",
    external_id: `coinbase:v2-account:${acct.id}:${todayDate}`,
    payload: acct,
  };
}

export function rawEventFromV2Txn(
  txn: V2Transaction,
): Extract<Operation, { kind: "raw_event" }> {
  return {
    kind: "raw_event",
    source: "coinbase",
    external_id: `coinbase:v2-txn:${txn.id}`,
    payload: txn,
  };
}

export interface AccountDiscoveryInput {
  v3_uuid?: string;
  v2_uuid?: string;
  display_name: string;
  currency: string;
}

/** Walk/pricing chain string; empty becomes null on the ledger draft. */
export type PositionSnapshotInput = Pick<
  PositionSnapshotDraft,
  "account_id" | "symbol" | "as_of" | "qty" | "price_usd"
> & {
  chain: string;
};

export function positionSnapshotFor(
  draft: PositionSnapshotInput,
): Extract<Operation, { kind: "position_snapshot" }> {
  return {
    kind: "position_snapshot",
    draft: {
      account_id: draft.account_id,
      symbol: draft.symbol,
      chain: draft.chain === "" ? null : draft.chain,
      contract_address: null,
      as_of: draft.as_of,
      qty: draft.qty,
      price_usd: draft.price_usd,
      source: "coinbase",
    },
  };
}

export function accountDiscoveryFor(
  input: AccountDiscoveryInput,
): Extract<Operation, { kind: "account_discovery" }> {
  const id = input.v3_uuid ?? input.v2_uuid;
  if (!id) {
    throw new Error("accountDiscoveryFor: at least one of v3_uuid / v2_uuid is required");
  }
  return {
    kind: "account_discovery",
    draft: {
      id: `coinbase:${id}`,
      display_name: input.display_name,
      institution: "Coinbase",
      type: "brokerage",
      currency: input.currency,
      mode: "live",
      external_id: id,
      source: "coinbase",
    },
  };
}

import { describe, expect, test } from "bun:test";
import type { AccountDraft, Operation } from "@coffer/ledger/runner";
import { AccountDiscoveryTracker } from "../../src/shared/discovery/account-tracker";

function draft(over: Partial<AccountDraft> = {}): AccountDraft {
  return {
    id: "simplefin:checking-1",
    display_name: "Checking",
    institution: "Test Bank",
    type: "checking",
    mode: "live",
    ...over,
  };
}

function collect(gen: Generator<Operation>): Operation[] {
  const out: Operation[] = [];
  for (const op of gen) out.push(op);
  return out;
}

describe("AccountDiscoveryTracker", () => {
  test("first discover yields exactly one account_discovery op", () => {
    const tracker = new AccountDiscoveryTracker();
    const d = draft();
    const ops = collect(tracker.discover(d));
    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({ kind: "account_discovery", draft: d });
  });

  test("second discover of the same id yields zero ops", () => {
    const tracker = new AccountDiscoveryTracker();
    const d = draft();
    collect(tracker.discover(d));
    const second = collect(tracker.discover(d));
    expect(second).toEqual([]);
  });

  test("discovering distinct ids yields one op each", () => {
    const tracker = new AccountDiscoveryTracker();
    const a = draft({ id: "simplefin:a" });
    const b = draft({ id: "simplefin:b" });
    const ops = [...collect(tracker.discover(a)), ...collect(tracker.discover(b))];
    expect(ops).toHaveLength(2);
    expect(ops[0]).toEqual({ kind: "account_discovery", draft: a });
    expect(ops[1]).toEqual({ kind: "account_discovery", draft: b });
  });

  test("emitted op carries the same draft reference passed in", () => {
    const tracker = new AccountDiscoveryTracker();
    const d = draft();
    const ops = collect(tracker.discover(d));
    expect((ops[0] as { kind: "account_discovery"; draft: AccountDraft }).draft).toBe(d);
  });
});

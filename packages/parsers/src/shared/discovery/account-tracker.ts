import type { AccountDraft, Operation } from "@coffer/ledger/runner";

export class AccountDiscoveryTracker {
  private readonly seen = new Set<string>();

  *discover(draft: AccountDraft): Generator<Operation> {
    if (this.seen.has(draft.id)) return;
    this.seen.add(draft.id);
    yield { kind: "account_discovery", draft };
  }
}

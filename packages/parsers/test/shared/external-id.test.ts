import { describe, expect, test } from "bun:test";
import { makeExternalId } from "../../src/shared/ids/external-id";

describe("makeExternalId", () => {
  test("uses intrinsic when present", () => {
    const id = makeExternalId({
      source: "simplefin",
      account: "acct-1",
      intrinsic: "txn-abc",
      fallback: () => "FALLBACK",
    });
    expect(id).toBe("simplefin:acct-1:txn-abc");
  });

  test("uses fallback when intrinsic is null", () => {
    const id = makeExternalId({
      source: "manual-csv",
      account: "acct-2",
      intrinsic: null,
      fallback: () => "hash-xyz",
    });
    expect(id).toBe("manual-csv:acct-2:hash-xyz");
  });

  test("uses fallback when intrinsic is the empty string", () => {
    const id = makeExternalId({
      source: "alchemy",
      account: "acct-3",
      intrinsic: "",
      fallback: () => "hash-zzz",
    });
    expect(id).toBe("alchemy:acct-3:hash-zzz");
  });

  test("does not call fallback when intrinsic is present", () => {
    let called = 0;
    const id = makeExternalId({
      source: "zerion",
      account: "acct-4",
      intrinsic: "hash-1",
      fallback: () => {
        called++;
        return "UNUSED";
      },
    });
    expect(id).toBe("zerion:acct-4:hash-1");
    expect(called).toBe(0);
  });
});

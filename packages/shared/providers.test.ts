// packages/shared/providers.test.ts
import { test, expect } from "bun:test";
import { PROVIDERS, getProvider } from "./providers";

test("registry has all six providers", () => {
  expect(PROVIDERS.map((p) => p.id).sort()).toEqual(
    ["alchemy", "coinbase", "defillama", "geckoterminal", "simplefin", "zerion"],
  );
});

test("simplefin is auth + special, with the access-url secret", () => {
  const p = getProvider("simplefin")!;
  expect(p.needsAuth).toBe(true);
  expect(p.special).toBe("simplefin");
  expect(p.fields[0].secretName).toBe("SIMPLEFIN_ACCESS_URL");
});

test("zerion has an api key secret and a wallets config field", () => {
  const p = getProvider("zerion")!;
  expect(p.fields.find((f) => f.secretName === "ZERION_API_KEY")).toBeTruthy();
  const w = p.fields.find((f) => f.configKey === "wallets")!;
  expect(w.multi).toBe(true);
});

test("coinbase has two secret fields incl a textarea private key", () => {
  const p = getProvider("coinbase")!;
  const secretNames = p.fields.filter((f) => f.secretName).map((f) => f.secretName);
  expect(secretNames).toEqual(["COINBASE_KEY_NAME", "COINBASE_PRIVATE_KEY"]);
  expect(p.fields.find((f) => f.secretName === "COINBASE_PRIVATE_KEY")!.kind).toBe("textarea");
});

test("no-auth providers have no fields", () => {
  expect(getProvider("defillama")!.needsAuth).toBe(false);
  expect(getProvider("geckoterminal")!.fields).toEqual([]);
});

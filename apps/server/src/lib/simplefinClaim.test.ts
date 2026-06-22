// apps/server/src/lib/simplefinClaim.test.ts
import { test, expect } from "bun:test";
import { resolveSimplefinAccessUrl } from "./simplefinClaim";

test("passes through an existing access URL unchanged (no network)", async () => {
  const url = "https://user:pass@bridge.simplefin.org/simplefin";
  const out = await resolveSimplefinAccessUrl(url, (() => { throw new Error("should not fetch"); }) as unknown as typeof fetch);
  expect(out).toBe(url);
});

test("decodes a setup token and POSTs to the claim URL", async () => {
  const claimUrl = "https://beta-bridge.simplefin.org/simplefin/claim/abc";
  const token = Buffer.from(claimUrl, "utf8").toString("base64");
  let posted: { url: string; method?: string } | null = null;
  const fakeFetch = (async (url: string, init?: { method?: string }) => {
    posted = { url, method: init?.method };
    return { ok: true, status: 200, text: async () => "https://u:p@bridge.simplefin.org/access\n" } as Response;
  }) as unknown as typeof fetch;
  const out = await resolveSimplefinAccessUrl(token, fakeFetch);
  expect(posted!.url).toBe(claimUrl);
  expect(posted!.method).toBe("POST");
  expect(out).toBe("https://u:p@bridge.simplefin.org/access");
});

test("throws on a token that doesn't decode to a URL", async () => {
  const bad = Buffer.from("not-a-url", "utf8").toString("base64");
  await expect(resolveSimplefinAccessUrl(bad)).rejects.toThrow();
});

test("throws when the claim POST is not ok", async () => {
  const token = Buffer.from("https://x/claim", "utf8").toString("base64");
  const fakeFetch = (async () => ({ ok: false, status: 403, text: async () => "" } as Response)) as unknown as typeof fetch;
  await expect(resolveSimplefinAccessUrl(token, fakeFetch)).rejects.toThrow();
});

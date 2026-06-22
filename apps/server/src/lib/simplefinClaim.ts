// apps/server/src/lib/simplefinClaim.ts

/** Convert a SimpleFIN setup token (base64 of a one-time claim URL) into a
 *  long-lived access URL. If `input` is already an http(s) access URL it is
 *  returned unchanged. `fetchImpl` is injectable for tests. */
export async function resolveSimplefinAccessUrl(
  input: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;

  let claimUrl: string;
  try {
    claimUrl = Buffer.from(trimmed, "base64").toString("utf8").trim();
  } catch {
    throw new Error("invalid SimpleFIN setup token");
  }
  if (!/^https?:\/\//i.test(claimUrl)) {
    throw new Error("invalid SimpleFIN setup token");
  }

  const res = await fetchImpl(claimUrl, { method: "POST" });
  if (!res.ok) throw new Error(`SimpleFIN claim failed: ${res.status}`);
  const accessUrl = (await res.text()).trim();
  if (!/^https?:\/\//i.test(accessUrl)) {
    throw new Error("SimpleFIN claim returned an invalid access URL");
  }
  return accessUrl;
}

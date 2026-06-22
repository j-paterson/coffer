export interface BuildCoinbaseJwtOpts {
  keyName: string;        // e.g., "organizations/{org}/apiKeys/{key}"
  privateKeyPem: string;  // PEM-encoded EC P-256 private key (PKCS8)
  method: string;         // e.g., "GET"
  host: string;           // e.g., "api.coinbase.com"
  path: string;           // e.g., "/api/v3/brokerage/accounts" (no query string)
  now?: () => number;     // ms since epoch; default Date.now
  nonce?: () => string;   // default: random 16-byte base64url
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlEncodeString(s: string): string {
  return base64UrlEncode(new TextEncoder().encode(s));
}

function randomNonce(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
}

function pemToDer(pem: string): Uint8Array {
  // Normalize literal `\n` (two chars) into real LF, then strip header/footer/whitespace.
  const normalized = pem.replace(/\\n/g, "\n");
  const body = normalized
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function buildCoinbaseJwt(opts: BuildCoinbaseJwtOpts): Promise<string> {
  const nowMs = (opts.now ?? Date.now)();
  const nbf = Math.floor(nowMs / 1000);
  const exp = nbf + 120;
  const nonce = (opts.nonce ?? randomNonce)();

  const header = { alg: "ES256", typ: "JWT", kid: opts.keyName, nonce };
  const claims = {
    iss: opts.keyName,
    sub: opts.keyName,
    nbf,
    exp,
    uri: `${opts.method} ${opts.host}${opts.path}`,
  };

  const headerB64 = base64UrlEncodeString(JSON.stringify(header));
  const claimsB64 = base64UrlEncodeString(JSON.stringify(claims));
  const signingInput = `${headerB64}.${claimsB64}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(opts.privateKeyPem).buffer as ArrayBuffer,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      new TextEncoder().encode(signingInput),
    ),
  );
  return `${signingInput}.${base64UrlEncode(sig)}`;
}

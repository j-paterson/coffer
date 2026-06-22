import { describe, expect, test } from "bun:test";
import { buildCoinbaseJwt } from "../../src/shared/jwt-es256";

// PEM-encoded EC P-256 private key generated for testing. The matching
// public key is derived below via crypto.subtle.importKey on the same PKCS8
// bytes (private import yields a key with public counterpart accessible via
// JWK round-trip).
//
// To regenerate:
//   openssl ecparam -genkey -name prime256v1 -noout -out k.pem
//   openssl pkcs8 -topk8 -nocrypt -in k.pem
//
// (Keep this fixture stable. Any change here forces a snapshot regeneration
//  for the deterministic-output test.)
const TEST_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgAVrtdp45Pli+Gxcf
1lN4H87I5AzTCmmcp7xgL/SeCJqhRANCAATcrMYWKvAQ/+ALpDcPkTEDV4W5d2uF
6fh46v/ZDHaVBRQKm5rrR3YE6Onq6a+6Kj//1hR2GUREaeNrXyORNqTo
-----END PRIVATE KEY-----`;

function base64UrlDecode(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJwtParts(jwt: string): { header: any; claims: any; signature: Uint8Array; signedInput: string } {
  const [h, c, s] = jwt.split(".") as [string, string, string];
  return {
    header: JSON.parse(new TextDecoder().decode(base64UrlDecode(h))),
    claims: JSON.parse(new TextDecoder().decode(base64UrlDecode(c))),
    signature: base64UrlDecode(s),
    signedInput: `${h}.${c}`,
  };
}

async function importPublicFromPrivate(pem: string): Promise<CryptoKey> {
  // Import private to get the JWK, then re-import the public half.
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  const priv = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", priv);
  return crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

const COMMON = {
  keyName: "organizations/abc/apiKeys/xyz",
  privateKeyPem: TEST_KEY_PEM,
  method: "GET",
  host: "api.coinbase.com",
  path: "/api/v3/brokerage/accounts",
};

describe("buildCoinbaseJwt — header", () => {
  test("contains alg=ES256, typ=JWT, kid=keyName, non-empty nonce", async () => {
    const jwt = await buildCoinbaseJwt(COMMON);
    const { header } = decodeJwtParts(jwt);
    expect(header.alg).toBe("ES256");
    expect(header.typ).toBe("JWT");
    expect(header.kid).toBe(COMMON.keyName);
    expect(typeof header.nonce).toBe("string");
    expect(header.nonce.length).toBeGreaterThan(0);
  });
});

describe("buildCoinbaseJwt — claims", () => {
  test("iss/sub = keyName, exp - nbf === 120, uri formatted", async () => {
    const jwt = await buildCoinbaseJwt(COMMON);
    const { claims } = decodeJwtParts(jwt);
    expect(claims.iss).toBe(COMMON.keyName);
    expect(claims.sub).toBe(COMMON.keyName);
    expect(typeof claims.nbf).toBe("number");
    expect(typeof claims.exp).toBe("number");
    expect(claims.exp - claims.nbf).toBe(120);
    expect(claims.uri).toBe("GET api.coinbase.com/api/v3/brokerage/accounts");
  });
});

describe("buildCoinbaseJwt — signature verifies", () => {
  test("signature is raw R||S (64 bytes) and verifies against public key", async () => {
    const jwt = await buildCoinbaseJwt(COMMON);
    const { signature, signedInput } = decodeJwtParts(jwt);
    expect(signature.length).toBe(64);

    const pub = await importPublicFromPrivate(TEST_KEY_PEM);
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pub,
      signature.buffer as ArrayBuffer,
      new TextEncoder().encode(signedInput),
    );
    expect(ok).toBe(true);
  });
});

describe("buildCoinbaseJwt — deterministic given fixed now+nonce", () => {
  test("header+claims are identical for two calls with same now+nonce", async () => {
    const opts = {
      ...COMMON,
      now: () => 1_700_000_000_000,
      nonce: () => "fixed-nonce-xyz",
    };
    const jwt1 = await buildCoinbaseJwt(opts);
    const jwt2 = await buildCoinbaseJwt(opts);

    const [h1, c1] = jwt1.split(".");
    const [h2, c2] = jwt2.split(".");
    expect(h1).toBe(h2);
    expect(c1).toBe(c2);
    // Signature varies (ECDSA is randomized) — that's expected, don't assert.

    const { header, claims } = decodeJwtParts(jwt1);
    expect(header.nonce).toBe("fixed-nonce-xyz");
    expect(claims.nbf).toBe(1_700_000_000);
    expect(claims.exp).toBe(1_700_000_120);
  });
});

describe("buildCoinbaseJwt — uri formatting", () => {
  test("METHOD HOST PATH with single spaces and no query string", async () => {
    const jwt = await buildCoinbaseJwt({
      ...COMMON,
      method: "GET",
      host: "api.coinbase.com",
      path: "/v2/accounts",
    });
    const { claims } = decodeJwtParts(jwt);
    expect(claims.uri).toBe("GET api.coinbase.com/v2/accounts");
  });
});

describe("buildCoinbaseJwt — newline normalization", () => {
  test("accepts a PEM where newlines are encoded as literal '\\n' characters", async () => {
    const pemWithLiteralBackslashN = TEST_KEY_PEM.replace(/\n/g, "\\n");
    const jwt = await buildCoinbaseJwt({ ...COMMON, privateKeyPem: pemWithLiteralBackslashN });
    const { signature, signedInput } = decodeJwtParts(jwt);

    const pub = await importPublicFromPrivate(TEST_KEY_PEM);
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pub,
      signature.buffer as ArrayBuffer,
      new TextEncoder().encode(signedInput),
    );
    expect(ok).toBe(true);
  });
});

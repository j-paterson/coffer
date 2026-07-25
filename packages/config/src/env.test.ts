import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { loadRootEnv } from "./env";

let dir: string;
const TOUCHED = [
  "COFFER_TEST_A",
  "COFFER_TEST_B",
  "COFFER_TEST_QUOTED",
  "COFFER_TEST_EXISTING",
];

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "coffer-env-"));
  for (const k of TOUCHED) delete process.env[k];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of TOUCHED) delete process.env[k];
});

test("loads KEY=VALUE pairs from a .env in the given root", () => {
  writeFileSync(resolve(dir, ".env"), "COFFER_TEST_A=hello\nCOFFER_TEST_B=world\n");
  loadRootEnv(dir);
  expect(process.env.COFFER_TEST_A).toBe("hello");
  expect(process.env.COFFER_TEST_B).toBe("world");
});

test("does not overwrite an already-set variable (shell wins)", () => {
  process.env.COFFER_TEST_EXISTING = "from-shell";
  writeFileSync(resolve(dir, ".env"), "COFFER_TEST_EXISTING=from-file\n");
  loadRootEnv(dir);
  expect(process.env.COFFER_TEST_EXISTING).toBe("from-shell");
});

test("skips comments and blank lines, strips surrounding quotes", () => {
  writeFileSync(
    resolve(dir, ".env"),
    "# a comment\n\nCOFFER_TEST_QUOTED=\"quoted value\"\n",
  );
  loadRootEnv(dir);
  expect(process.env.COFFER_TEST_QUOTED).toBe("quoted value");
});

test("missing .env is a no-op (does not throw)", () => {
  expect(() => loadRootEnv(dir)).not.toThrow();
});

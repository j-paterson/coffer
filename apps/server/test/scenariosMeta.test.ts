import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestCtx } from "./setup";
import { loadScenario } from "./scenarios";

const here = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES_DIR = resolve(here, "../../../db/fixtures");

const fixtures = readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith(".yaml") && !f.startsWith("_"))
  .sort();

describe("every fixture loads cleanly through TS", () => {
  for (const fname of fixtures) {
    const name = fname.replace(/\.yaml$/, "");
    test(name, () => {
      const { db } = createTestCtx();
      const doc = loadScenario(db, name);
      expect(doc.name).toBe(name);
    });
  }
});

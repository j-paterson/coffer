import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  defineConfig,
  PARSER_SCHEMAS,
  type ParserId,
  type FinanceConfigInput,
} from "../src/index";

const EXPECTED_IDS: ParserId[] = [
  "simplefin", "defillama", "zerion", "alchemy", "geckoterminal", "coinbase",
];

describe("PARSER_SCHEMAS", () => {
  test("has one Zod schema per supported parser id", () => {
    for (const id of EXPECTED_IDS) {
      const schema = PARSER_SCHEMAS[id];
      expect(schema).toBeDefined();
      expect(schema instanceof z.ZodType).toBe(true);
    }
  });

  test("has exactly the six expected keys (no extras, no gaps)", () => {
    const keys = Object.keys(PARSER_SCHEMAS).sort();
    expect(keys).toEqual([...EXPECTED_IDS].sort());
  });
});

describe("defineConfig", () => {
  test("is identity at runtime", () => {
    const input: FinanceConfigInput = {
      parsers: {
        simplefin: { lookback_days: 30 },
        coinbase: {},
      },
    };
    expect(defineConfig(input)).toBe(input);
  });

  test("accepts empty input", () => {
    expect(defineConfig({})).toEqual({});
  });

  test("accepts empty parsers map", () => {
    expect(defineConfig({ parsers: {} })).toEqual({ parsers: {} });
  });
});

describe("FinanceConfigInput type", () => {
  // This is a compile-time test — if the type is wrong, the file won't typecheck.
  // bun test still runs it as a no-op runtime test, which is fine.
  test("permits every parser id with empty entry", () => {
    const cfg: FinanceConfigInput = {
      parsers: {
        simplefin: {},
        defillama: {},
        zerion: { wallets: [] },
        alchemy: { wallets: [] },
        geckoterminal: { targets: [] as never },
        coinbase: {},
      },
    };
    expect(cfg.parsers).toBeDefined();
  });
});

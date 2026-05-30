import { describe, expect, test } from "bun:test";
import { REGISTRY, type ParserId } from "../src/registry";

const EXPECTED_IDS: ParserId[] = [
  "simplefin", "coinbase", "alchemy", "zerion", "defillama", "geckoterminal",
];

describe("REGISTRY", () => {
  test("has a parser for every supported parser id", () => {
    for (const id of EXPECTED_IDS) {
      const parser = REGISTRY[id];
      expect(parser).toBeDefined();
      expect(parser.id).toBe(id);
      expect(typeof parser.sync).toBe("function");
      expect(parser.configSchema).toBeDefined();
    }
  });

  test("parser names match canonical labels", () => {
    expect(REGISTRY.simplefin.name).toBe("SimpleFIN");
    expect(REGISTRY.coinbase.name).toBe("Coinbase");
    expect(REGISTRY.alchemy.name).toBe("Alchemy");
    expect(REGISTRY.zerion.name).toBe("Zerion");
    expect(REGISTRY.defillama.name).toBe("DefiLlama");
    expect(REGISTRY.geckoterminal.name).toBe("GeckoTerminal");
  });

  test("has no buildConfig (shrunk shape — Phase 4)", () => {
    const value = REGISTRY.simplefin as unknown as Record<string, unknown>;
    expect(value.buildConfig).toBeUndefined();
  });
});

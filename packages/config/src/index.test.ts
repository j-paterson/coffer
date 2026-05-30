import { describe, it, expect } from "bun:test";
import { defineConfig, type FinanceConfigInput } from "./index";

describe("defineConfig", () => {
  it("returns the config object unchanged", () => {
    const input: FinanceConfigInput = { parsers: { simplefin: {} } };
    expect(defineConfig(input)).toBe(input);
  });

  it("accepts a walker block and passes it through", () => {
    const input: FinanceConfigInput = {
      parsers: { simplefin: {} },
      walker: {
        networthFloor: "2023-01-01",
        assetOnlyTypes: ["crypto", "brokerage"],
      },
    };
    const result = defineConfig(input);
    expect(result.walker?.networthFloor).toBe("2023-01-01");
    expect(result.walker?.assetOnlyTypes).toEqual(["crypto", "brokerage"]);
  });

  it("accepts walker with only networthFloor (assetOnlyTypes optional)", () => {
    const input: FinanceConfigInput = {
      walker: { networthFloor: "2022-06-01" },
    };
    const result = defineConfig(input);
    expect(result.walker?.networthFloor).toBe("2022-06-01");
    expect(result.walker?.assetOnlyTypes).toBeUndefined();
  });

  it("accepts walker with only assetOnlyTypes (networthFloor optional)", () => {
    const input: FinanceConfigInput = {
      walker: { assetOnlyTypes: [] },
    };
    const result = defineConfig(input);
    expect(result.walker?.assetOnlyTypes).toEqual([]);
    expect(result.walker?.networthFloor).toBeUndefined();
  });

  it("walker section is optional — config without it is valid", () => {
    const input: FinanceConfigInput = { parsers: { defillama: {} } };
    const result = defineConfig(input);
    expect(result.walker).toBeUndefined();
  });

  it("parsers and walker are both optional — empty config is valid", () => {
    const result = defineConfig({});
    expect(result.parsers).toBeUndefined();
    expect(result.walker).toBeUndefined();
  });
});

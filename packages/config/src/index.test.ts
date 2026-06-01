import { describe, it, expect } from "bun:test";
import { defineConfig, type FinanceConfigInput } from "./index";

describe("defineConfig", () => {
  it("returns the config object unchanged", () => {
    const input: FinanceConfigInput = { parsers: { simplefin: {} } };
    expect(defineConfig(input)).toBe(input);
  });

  it("parsers are optional — empty config is valid", () => {
    const result = defineConfig({});
    expect(result.parsers).toBeUndefined();
  });
});

import { describe, expect, test } from "bun:test";
import { SKIP } from "../src/skip";

describe("SKIP sentinel", () => {
  test("is a unique symbol", () => {
    expect(typeof SKIP).toBe("symbol");
    expect(SKIP.toString()).toContain("SKIP");
  });
});

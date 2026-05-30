import { describe, expect, test } from "bun:test";
import { parseDate } from "../src/manual-csv/date";

describe("parseDate", () => {
  test("parses YYYY-MM-DD as ISO", () => {
    expect(parseDate("2025-03-15", "YYYY-MM-DD")).toBe("2025-03-15");
  });

  test("normalizes MM/DD/YYYY to ISO", () => {
    expect(parseDate("03/15/2025", "MM/DD/YYYY")).toBe("2025-03-15");
  });

  test("normalizes DD/MM/YYYY to ISO", () => {
    expect(parseDate("15/03/2025", "DD/MM/YYYY")).toBe("2025-03-15");
  });

  test("zero-pads single-digit month and day", () => {
    expect(parseDate("3/5/2025", "MM/DD/YYYY")).toBe("2025-03-05");
    expect(parseDate("5/3/2025", "DD/MM/YYYY")).toBe("2025-03-05");
  });

  test("trims surrounding whitespace", () => {
    expect(parseDate("  2025-03-15  ", "YYYY-MM-DD")).toBe("2025-03-15");
  });

  test("rejects malformed YYYY-MM-DD", () => {
    expect(() => parseDate("2025/03/15", "YYYY-MM-DD")).toThrow();
    expect(() => parseDate("not-a-date", "YYYY-MM-DD")).toThrow();
  });

  test("rejects invalid month or day", () => {
    expect(() => parseDate("2025-13-01", "YYYY-MM-DD")).toThrow();
    expect(() => parseDate("2025-02-30", "YYYY-MM-DD")).toThrow();
    expect(() => parseDate("13/01/2025", "MM/DD/YYYY")).toThrow();
  });
});

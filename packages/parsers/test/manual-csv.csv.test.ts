import { describe, expect, test } from "bun:test";
import { parseCsv } from "../src/manual-csv/csv";

describe("parseCsv", () => {
  test("parses a simple header + rows", () => {
    const out = parseCsv("date,description,amount\n2025-01-01,Coffee,-5.00\n2025-01-02,Lunch,-12.50\n");
    expect(out.header).toEqual(["date", "description", "amount"]);
    expect(out.rows).toEqual([
      { lineNumber: 1, fields: ["2025-01-01", "Coffee", "-5.00"] },
      { lineNumber: 2, fields: ["2025-01-02", "Lunch", "-12.50"] },
    ]);
  });

  test("handles quoted fields with commas", () => {
    const out = parseCsv(`a,b\n"hello, world",x\n`);
    expect(out.rows[0]?.fields).toEqual(["hello, world", "x"]);
  });

  test("handles escaped quotes (double-quote)", () => {
    const out = parseCsv(`a\n"she said ""hi"""\n`);
    expect(out.rows[0]?.fields).toEqual([`she said "hi"`]);
  });

  test("handles embedded newlines inside quoted fields", () => {
    const out = parseCsv(`a,b\n"line1\nline2",x\n`);
    expect(out.rows[0]?.fields).toEqual(["line1\nline2", "x"]);
  });

  test("handles \\r\\n line endings", () => {
    const out = parseCsv("a,b\r\n1,2\r\n3,4\r\n");
    expect(out.rows.map((r) => r.fields)).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  test("strips a UTF-8 BOM from the start", () => {
    const out = parseCsv("﻿date,amount\n2025-01-01,1\n");
    expect(out.header).toEqual(["date", "amount"]);
  });

  test("ignores a trailing newline without producing an empty row", () => {
    const out = parseCsv("a,b\n1,2\n");
    expect(out.rows.length).toBe(1);
  });

  test("trims trailing \\r at end of unquoted last field", () => {
    const out = parseCsv("a,b\r\n1,2\r\n");
    expect(out.rows[0]?.fields).toEqual(["1", "2"]);
  });

  test("throws on empty input", () => {
    expect(() => parseCsv("")).toThrow(/empty/i);
  });

  test("lineNumber is 1-based and counts data rows only", () => {
    const out = parseCsv("a\n1\n2\n3\n");
    expect(out.rows.map((r) => r.lineNumber)).toEqual([1, 2, 3]);
  });
});

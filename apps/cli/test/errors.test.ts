import { describe, expect, test } from "bun:test";
import { SchemaOutdatedError, rewrapSchemaError } from "../src/errors";

describe("SchemaOutdatedError", () => {
  test("message includes missing table when provided", () => {
    const e = new SchemaOutdatedError("positions");
    expect(e.message).toContain("positions");
    expect(e.message).toContain("finance migrate");
    expect(e.name).toBe("SchemaOutdatedError");
  });

  test("message handles null missing table", () => {
    const e = new SchemaOutdatedError(null);
    expect(e.message).toContain("schema appears outdated");
    expect(e.message).not.toContain("(missing table:");
  });

  test("instanceof Error", () => {
    expect(new SchemaOutdatedError("x")).toBeInstanceOf(Error);
  });
});

describe("rewrapSchemaError", () => {
  test("rewraps 'no such table: positions' → SchemaOutdatedError('positions')", () => {
    const original = new Error("SQLITE_ERROR: no such table: positions");
    const out = rewrapSchemaError(original);
    expect(out).toBeInstanceOf(SchemaOutdatedError);
    expect(out.message).toContain("positions");
  });

  test("rewraps 'no such table positions' (no colon) → SchemaOutdatedError", () => {
    const original = new Error("no such table positions");
    const out = rewrapSchemaError(original);
    expect(out).toBeInstanceOf(SchemaOutdatedError);
  });

  test("returns original Error when message doesn't match", () => {
    const original = new Error("something else");
    const out = rewrapSchemaError(original);
    expect(out).toBe(original);
  });

  test("wraps non-Error values in a generic Error", () => {
    const out = rewrapSchemaError("string error");
    expect(out).toBeInstanceOf(Error);
    expect(out.message).toBe("string error");
  });
});

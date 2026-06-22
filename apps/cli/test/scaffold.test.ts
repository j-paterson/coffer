import { describe, expect, test } from "bun:test";

describe("scaffold", () => {
  test("the workspace is wired", async () => {
    const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
    expect(pkg.name).toBe("@coffer/cli");
    expect(pkg.type).toBe("module");
    expect(pkg.bin).toEqual({ "coffer": "./src/index.ts" });
    expect(pkg.dependencies["@coffer/parsers"]).toBe("workspace:*");
    expect(pkg.dependencies["@coffer/ledger"]).toBe("workspace:*");
  });
});

import { describe, expect, test } from "bun:test";

describe("scaffold", () => {
  test("the workspace is wired", async () => {
    const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
    expect(pkg.name).toBe("@coffer/config");
    expect(pkg.type).toBe("module");
    expect(pkg.dependencies["@coffer/parsers"]).toBe("workspace:*");
    expect(pkg.dependencies.zod).toBeDefined();
    expect(pkg.exports["."]).toBe("./src/index.ts");
  });
});

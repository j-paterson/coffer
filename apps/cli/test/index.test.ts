import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgv, usage, ArgvError } from "../src/index";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES = resolve(HERE, "./fixtures");

describe("parseArgv — happy paths", () => {
  test("sync coinbase", () => {
    expect(parseArgv(["sync", "coinbase"])).toEqual({
      command: "sync",
      parserId: "coinbase",
      flags: {},
    });
  });

  test("sync simplefin --days 30", () => {
    expect(parseArgv(["sync", "simplefin", "--days", "30"])).toEqual({
      command: "sync",
      parserId: "simplefin",
      flags: { days: 30 },
    });
  });

  test("sync zerion --events-fd 3", () => {
    expect(parseArgv(["sync", "zerion", "--events-fd", "3"])).toEqual({
      command: "sync",
      parserId: "zerion",
      flags: { eventsFd: 3 },
    });
  });

  test("sync defillama --config <path>", () => {
    const p = resolve(FIXTURES, "defillama-manual.ts");
    expect(parseArgv(["sync", "defillama", "--config", p])).toEqual({
      command: "sync",
      parserId: "defillama",
      flags: { config: p },
    });
  });

  test("all three flags together, any order", () => {
    const p = resolve(FIXTURES, "empty-config.ts");
    expect(parseArgv(["sync", "simplefin", "--events-fd", "3", "--config", p, "--days", "7"])).toEqual({
      command: "sync",
      parserId: "simplefin",
      flags: { days: 7, eventsFd: 3, config: p },
    });
  });
});

describe("parseArgv — rejections", () => {
  test("empty argv → ArgvError", () => {
    expect(() => parseArgv([])).toThrow(ArgvError);
  });

  test("unknown command → ArgvError", () => {
    expect(() => parseArgv(["migrate"])).toThrow(ArgvError);
  });

  test("sync without parser id → ArgvError", () => {
    expect(() => parseArgv(["sync"])).toThrow(ArgvError);
  });

  test("unknown parser id → ArgvError", () => {
    expect(() => parseArgv(["sync", "yahoo"])).toThrow(ArgvError);
  });

  test("--days non-numeric → ArgvError", () => {
    expect(() => parseArgv(["sync", "simplefin", "--days", "abc"])).toThrow(ArgvError);
  });

  test("--days missing value → ArgvError", () => {
    expect(() => parseArgv(["sync", "simplefin", "--days"])).toThrow(ArgvError);
  });

  test("--events-fd non-numeric → ArgvError", () => {
    expect(() => parseArgv(["sync", "simplefin", "--events-fd", "x"])).toThrow(ArgvError);
  });

  test("--config missing value → ArgvError", () => {
    expect(() => parseArgv(["sync", "simplefin", "--config"])).toThrow(ArgvError);
  });

  test("unknown flag → ArgvError", () => {
    expect(() => parseArgv(["sync", "simplefin", "--force"])).toThrow(ArgvError);
  });
});

describe("usage", () => {
  test("includes the sync subcommand and known parser ids", () => {
    const u = usage();
    expect(u).toContain("sync");
    expect(u).toContain("coinbase");
    expect(u).toContain("simplefin");
    expect(u).toContain("alchemy");
    expect(u).toContain("zerion");
    expect(u).toContain("defillama");
    expect(u).toContain("geckoterminal");
  });

  test("documents the --config flag", () => {
    expect(usage()).toContain("--config");
  });
});

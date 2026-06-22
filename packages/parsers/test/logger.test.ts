import { describe, expect, test, mock } from "bun:test";
import { ConsoleLogger } from "../src/types/logger";

describe("ConsoleLogger", () => {
  test("debug/info/warn/error route to the matching sink method", () => {
    const debug = mock(() => {});
    const info = mock(() => {});
    const warn = mock(() => {});
    const error = mock(() => {});
    const sink = { debug, info, warn, error };
    const logger = new ConsoleLogger(sink);

    logger.debug("d", { k: 1 });
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    expect(debug).toHaveBeenCalledWith("d", { k: 1 });
    expect(info).toHaveBeenCalledWith("i");
    expect(warn).toHaveBeenCalledWith("w");
    expect(error).toHaveBeenCalledWith("e");
  });
});

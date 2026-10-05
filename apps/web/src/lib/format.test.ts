import { describe, expect, it } from "vitest";
import { formatDate, localIsoDate } from "./format";

// Pin a US zone so a midnight-UTC parse would land on the previous calendar day.
(globalThis as any).process.env.TZ = "America/Los_Angeles";

describe("formatDate", () => {
  it("renders a bare YYYY-MM-DD as that calendar day, not the day before", () => {
    expect(formatDate("2025-08-14")).toBe("Aug 14, 2025");
    expect(formatDate("2025-01-01")).toBe("Jan 1, 2025");
  });

  it("still formats full timestamps and passes through junk", () => {
    expect(formatDate("2025-08-14T18:00:00Z")).toBe("Aug 14, 2025");
    expect(formatDate("not a date")).toBe("not a date");
    expect(formatDate(null)).toBe("—");
  });
});

describe("localIsoDate", () => {
  it("uses the local calendar day, not the UTC one", () => {
    // 10pm local on Oct 5 is already Oct 6 in UTC for US zones.
    expect(localIsoDate(new Date(2026, 9, 5, 22, 0))).toBe("2026-10-05");
    expect(localIsoDate(new Date(2026, 0, 9))).toBe("2026-01-09");
  });
});

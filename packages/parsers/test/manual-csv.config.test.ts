import { describe, expect, test } from "bun:test";
import { ManualCsvConfig } from "../src/manual-csv/config";

describe("ManualCsvConfig", () => {
  test("accepts a minimal config and applies defaults", () => {
    const parsed = ManualCsvConfig.parse({
      account_id: "manual:checking-1",
      files: ["/tmp/x.csv"],
      account: { display_name: "My Checking" },
    });
    expect(parsed.columns).toEqual({
      date: "date",
      description: "description",
      amount: "amount",
    });
    expect(parsed.date_format).toBe("YYYY-MM-DD");
    expect(parsed.sign_convention).toBe("debits-negative");
    expect(parsed.account.institution).toBe("manual");
    expect(parsed.account.type).toBe("checking");
    expect(parsed.account.currency).toBe("USD");
  });

  test("accepts a fully-specified config", () => {
    const parsed = ManualCsvConfig.parse({
      account_id: "brokerage:checking-9876",
      files: ["/tmp/march.csv", "/tmp/april.csv"],
      columns: { date: "Posting Date", description: "Memo", amount: "Amount" },
      date_format: "MM/DD/YYYY",
      sign_convention: "debits-positive",
      account: {
        display_name: "Northwind Checking",
        institution: "Northwind Bank",
        type: "checking",
        currency: "USD",
      },
    });
    expect(parsed.columns.date).toBe("Posting Date");
    expect(parsed.date_format).toBe("MM/DD/YYYY");
    expect(parsed.sign_convention).toBe("debits-positive");
  });

  test("rejects empty account_id", () => {
    expect(() => ManualCsvConfig.parse({
      account_id: "",
      files: ["/tmp/x.csv"],
      account: { display_name: "X" },
    })).toThrow();
  });

  test("rejects empty files array", () => {
    expect(() => ManualCsvConfig.parse({
      account_id: "a",
      files: [],
      account: { display_name: "X" },
    })).toThrow();
  });

  test("rejects unknown date_format", () => {
    expect(() => ManualCsvConfig.parse({
      account_id: "a",
      files: ["/tmp/x.csv"],
      date_format: "DD-MM-YYYY",
      account: { display_name: "X" },
    })).toThrow();
  });

  test("rejects empty account.display_name", () => {
    expect(() => ManualCsvConfig.parse({
      account_id: "a",
      files: ["/tmp/x.csv"],
      account: { display_name: "" },
    })).toThrow();
  });
});

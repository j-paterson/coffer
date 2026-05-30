import { test, expect, type Page } from "@playwright/test";

const SPENDING_URL = "/spending";

async function pickFirstCategoryWithTransactions(page: Page): Promise<string> {
  await page.goto(SPENDING_URL);
  await expect(page.getByRole("heading", { name: "Spending" })).toBeVisible();
  // Use a wider range so we have data to work with on a fresh dev DB.
  await page.getByRole("button", { name: "All" }).click();
  // The legend renders categories as buttons; click the first one.
  const firstCategoryBtn = page.locator("button:has(span.bg-emerald-500)").first();
  const label = (await firstCategoryBtn.textContent())?.split(/\s+\d/)[0]?.trim() ?? "";
  await firstCategoryBtn.click();
  return label;
}

test("right-click ignore + show-ignored pill recovers row", async ({ page }) => {
  await pickFirstCategoryWithTransactions(page);

  // Wait for the drill-down transactions list to render.
  const txnTable = page.locator("table").last();
  await expect(txnTable.locator("tbody tr").first()).toBeVisible();
  const initialRowCount = await txnTable.locator("tbody tr").count();
  expect(initialRowCount).toBeGreaterThan(0);

  // Capture the first row's date+description to identify it later.
  const firstRow = txnTable.locator("tbody tr").first();
  const rowSignature = (await firstRow.textContent()) ?? "";

  // Right-click the first row → menu opens with "Ignore in spending".
  // Scroll the row into view first (it may be below the fold), then right-click.
  const firstCell = firstRow.locator("td").first();
  await firstCell.scrollIntoViewIfNeeded();
  const box = await firstCell.boundingBox();
  if (!box) throw new Error("firstCell not found");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
  const ignoreItem = page.getByRole("menu").getByRole("menuitem", { name: "Ignore in spending" });
  await expect(ignoreItem).toBeVisible();

  // Wait for the PATCH to settle.
  const patch = page.waitForResponse(
    (r) => r.url().includes("/exclude") && r.request().method() === "PATCH" && r.status() === 200,
  );
  await ignoreItem.click();
  await patch;

  // Row count drops by one; "Show 1 ignored" pill appears.
  await expect(txnTable.locator("tbody tr")).toHaveCount(initialRowCount - 1);
  const showIgnored = page.getByRole("button", { name: /Show \d+ ignored/ });
  await expect(showIgnored).toBeVisible();

  // Click the pill → ignored row reappears, muted.
  const refetch = page.waitForResponse(
    (r) => r.url().includes("/api/v2/spending/transactions") && r.url().includes("include_excluded=1"),
  );
  await showIgnored.click();
  await refetch;
  await expect(txnTable.locator("tbody tr")).toHaveCount(initialRowCount);
  await expect(page.getByText("ignored", { exact: true }).first()).toBeVisible();

  // Right-click the muted row → "Un-ignore" → pill says "Hide ignored".
  const muted = txnTable.locator("tr.opacity-50").first();
  const mutedCell = muted.locator("td").first();
  await mutedCell.scrollIntoViewIfNeeded();
  const mutedBox = await mutedCell.boundingBox();
  if (!mutedBox) throw new Error("muted cell not found");
  await page.mouse.click(mutedBox.x + mutedBox.width / 2, mutedBox.y + mutedBox.height / 2, { button: "right" });
  const unignoreItem = page.getByRole("menu").getByRole("menuitem", { name: "Un-ignore" });
  const unpatch = page.waitForResponse(
    (r) => r.url().includes("/exclude") && r.request().method() === "PATCH" && r.status() === 200,
  );
  await unignoreItem.click();
  await unpatch;

  // After un-ignoring, the muted styling clears on the row.
  await expect(txnTable.locator("tr.opacity-50")).toHaveCount(0);
  // And the pill switches back to "Show 0 ignored" (or hides if count drops to 0;
  // this fixture-DB run produces exactly one ignored toggle so it should hide).
  await expect(page.getByRole("button", { name: /Show \d+ ignored/ })).toHaveCount(0);

  // Sanity: row signature unchanged.
  expect((await firstRow.textContent()) ?? "").toContain(rowSignature.split("·")[0]?.trim() ?? "");
});

import { test, expect } from "@playwright/test";

// Google One subscription — a receipt-backed single-item transaction.
// item_id=164, transaction_id=10013, account=Chase Sapphire Preferred (7800).
// We use a known item so we can restore state in afterEach.
const ITEM_ID = 164;
const TXN_ID = "10013";
const ORIGINAL_CATEGORY = "software";
const ORIGINAL_SUBCATEGORY = "software_subscription";
// home_renovation is the first entry in the categories API response.
// home_improvement is its first subcategory.
const TEST_CATEGORY = "home_renovation";
const TEST_SUBCATEGORY = "home_improvement";

test.afterEach(async ({ request }) => {
  // Restore the item to its original category regardless of test outcome.
  // Assumes Playwright's default single-worker run for e2e — parallel workers
  // would race on this shared item.
  await request.patch(`/api/items/${ITEM_ID}`, {
    data: {
      category: ORIGINAL_CATEGORY,
      subcategory: ORIGINAL_SUBCATEGORY,
    },
  });
});

// House Renovation 2025 bundle.
const RENOVATION_BUNDLE_ID = "renovation-7099fa16";

test("bundle's category_options appear under Suggested", async ({ page, request }) => {
  // Capture current category_options so we can restore in finally.
  const beforeRes = await request.get(`/api/bundles/${RENOVATION_BUNDLE_ID}`);
  const beforeBundle = await beforeRes.json();
  const originalOptions = beforeBundle.category_options ?? [];

  try {
    // Navigate to bundles list and open the renovation bundle.
    await page.goto("/bundles");
    await expect(page.getByRole("heading", { name: "Bundles" })).toBeVisible();
    await page.getByRole("button", { name: /House Renovation 2025/i }).first().click();

    // Wait for the detail panel to load.
    await expect(page.getByRole("button", { name: /Edit category options/i })).toBeVisible();

    // Expand the category options editor.
    await page.getByRole("button", { name: /Edit category options/i }).click();

    // Capture row count before add so we can target the appended row by index
    // rather than .last() — robust if rows are ever inserted non-tail.
    const inputs = page.getByTestId("category-options-input");
    const countBefore = await inputs.count();

    // Click "+ Add category" to add a new row.
    await page.getByTestId("category-options-add").click();
    await expect(inputs).toHaveCount(countBefore + 1);

    // Fill the newly-added row's category-name input.
    await inputs.nth(countBefore).fill("ZzzCustom");

    // Save. Sequence the assertion so we observe the round-trip:
    // becomes enabled (dirty), we click, then it returns to disabled (clean).
    const saveBtn = page.getByRole("button", { name: "Save" });
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();
    await expect(saveBtn).toBeDisabled();

    // Open the first transaction row's category dropdown.
    await page.locator("tr[data-testid^='txn-row-']").first()
      .locator("[data-testid='category-trigger']").click();

    // Assert ZzzCustom appears in the Suggested group.
    const suggested = page.getByTestId("dropdown-suggested-group");
    await expect(suggested).toContainText("ZzzCustom");

    // Close the dropdown.
    await page.keyboard.press("Escape");
  } finally {
    // Restore original category_options regardless of test outcome.
    await request.patch(`/api/bundles/${RENOVATION_BUNDLE_ID}/category_options`, {
      data: { category_options: originalOptions },
    });
  }
});

// Sentinel category: mixed-case input, but the API normalises to lower-case
// before persisting, so the server returns it as lower-case and the DOM
// data-category attribute carries the lower-case version.
const NEW_CATEGORY = "ZzzBrandNewCat";
const NEW_CATEGORY_LOWER = NEW_CATEGORY.toLowerCase(); // "zzzbrandnewcat"

test("free-text new category persists into global taxonomy", async ({
  page,
  request,
}) => {
  // We'll find the item ID dynamically after interacting with the first row.
  let mutatedItemId: number | null = null;
  let originalCategory: string | null = null;
  let originalSubcategory: string | null = null;

  try {
    // One fetch serves both the pre-clean and the item-id lookup below.
    // limit=200 bounds the scan; if the test DB grows past 200 transactions
    // a sentinel left behind by a prior crash could escape detection here
    // and produce a false-positive pass.
    const byAccountRes = await request.get("/api/transactions/by-account?limit=200");
    const byAccountData = await byAccountRes.json();

    // Pre-clean: remove any leftover sentinel from a previous failed run so
    // NEW_CATEGORY is truly absent from the taxonomy when we navigate.
    for (const group of byAccountData) {
      for (const txn of group.transactions ?? []) {
        for (const item of txn.items ?? []) {
          if (
            typeof item.category === "string" &&
            item.category.toLowerCase() === NEW_CATEGORY.toLowerCase()
          ) {
            await request.patch(`/api/items/${item.id}`, {
              data: { category: null, subcategory: null },
            });
          }
        }
      }
    }

    await page.goto("/transactions");
    await expect(page.getByRole("heading", { name: "Transactions" })).toBeVisible();

    // The first account auto-opens. Grab the first transaction row and its id.
    const firstRow = page.locator("tr[data-testid^='txn-row-']").first();
    await expect(firstRow).toBeVisible();
    const firstRowTestId = await firstRow.getAttribute("data-testid");
    // data-testid="txn-row-<txn_id>" — extract the txn id.
    const txnId = firstRowTestId?.replace("txn-row-", "") ?? null;

    // Look up the item id and its current category so we can restore later.
    // Assumes the row's category-trigger is the SingleItemCategoryDropdown
    // bound to items[0] — true for single-item rows, which is what the first
    // row of /transactions has been in this fixture. If the fixture ever
    // changes so the first row is multi-item, the trigger click below will
    // still succeed (each item has its own trigger inside the expanded sub-row),
    // but items[0] may not be the one mutated by the UI. Re-target if needed.
    if (txnId !== null) {
      outer: for (const group of byAccountData) {
        for (const txn of group.transactions ?? []) {
          if (String(txn.id) === txnId) {
            const item = (txn.items ?? [])[0];
            if (item) {
              mutatedItemId = item.id;
              originalCategory = item.category ?? null;
              originalSubcategory = item.subcategory ?? null;
            }
            break outer;
          }
        }
      }
    }
    // Refuse to mutate the UI without a known restore target — otherwise a
    // failed lookup leaves a sentinel category on a real item with no path
    // back to the original state.
    if (mutatedItemId === null) {
      throw new Error(
        `Could not resolve item id for first row (txnId=${txnId}); refusing to mutate UI without a restore target.`,
      );
    }

    // Open the category dropdown on the first row.
    await firstRow.locator("[data-testid='category-trigger']").click();
    const catInput = page.locator("input[placeholder='Filter or create…']").first();
    await expect(catInput).toBeVisible();

    // Type a brand-new category name. Since it doesn't exist, pressing Enter
    // commits it immediately (category set, no subcategory) and closes the popover.
    await catInput.fill(NEW_CATEGORY);
    await catInput.press("Enter");

    // Dropdown should be gone now — trigger text updated.
    await expect(firstRow.locator("[data-testid='category-trigger']")).toContainText(NEW_CATEGORY);

    // Open the second transaction row's dropdown — the React Query invalidation
    // triggered by the patch will have caused a background refetch of
    // /api/items/categories; the toBeVisible timeout below absorbs any remaining
    // in-flight latency.
    const secondRow = page.locator("tr[data-testid^='txn-row-']").nth(1);
    await secondRow.locator("[data-testid='category-trigger']").click();

    // Category rows are <button data-testid="category-row" data-category="…">.
    // The server normalises to lower-case so the attribute holds the lower-case form.
    await expect(
      page.locator(`[data-testid='category-row'][data-category='${NEW_CATEGORY_LOWER}']`),
    ).toBeVisible({ timeout: 10_000 });

    // Close the dropdown.
    await page.keyboard.press("Escape");
  } finally {
    // Restore the mutated item to its original category.
    if (mutatedItemId !== null) {
      await request.patch(`/api/items/${mutatedItemId}`, {
        data: { category: originalCategory, subcategory: originalSubcategory },
      });
    }
  }
});

test("setting a category via dropdown updates trigger text and persists across reload", async ({
  page,
  request,
}) => {
  // Put the item into a known uncategorized state so the dropdown starts fresh.
  await request.patch(`/api/items/${ITEM_ID}`, {
    data: { category: null, subcategory: null },
  });

  await page.goto("/transactions");
  await expect(page.getByRole("heading", { name: "Transactions" })).toBeVisible();

  // The page auto-opens the first account (Platinum Card). We also need to open
  // Chase Sapphire Preferred which holds the Google One single-item transaction.
  const cspSection = page.locator("section").filter({
    has: page.getByText("Chase Sapphire Preferred"),
  });
  const cspTable = cspSection.locator("table");
  if (!await cspTable.isVisible()) {
    await cspSection.locator("button").first().click();
    await expect(cspTable).toBeVisible();
  }

  // Scroll the Google One transaction row into view.
  const row = page.locator(`tr[data-testid='txn-row-${TXN_ID}']`);
  await row.scrollIntoViewIfNeeded();
  await expect(row).toBeVisible();

  // Trigger should say "Uncategorized" since we cleared the category above.
  const trigger = row.locator("[data-testid='category-trigger']");
  await expect(trigger).toBeVisible();
  await expect(trigger).toContainText("Uncategorized");

  // Open the dropdown and wait for the category filter input to appear.
  await trigger.click();
  const catFilterInput = page.locator("input[placeholder='Filter or create…']").first();
  await expect(catFilterInput).toBeVisible();

  // Type the target category name into the filter to narrow the list to
  // exactly one match.
  await catFilterInput.fill(TEST_CATEGORY);

  // Exactly one match means pressing Enter selects it and activates the
  // subcategory pane (selectCategory — does NOT commit yet).
  await catFilterInput.press("Enter");

  // Wait for the subcategory pane to show the target subcategory.
  const subFilterInput = page.locator("input[placeholder='Filter or create…']").nth(1);
  await expect(subFilterInput).toBeVisible();
  await subFilterInput.fill(TEST_SUBCATEGORY);

  // Exactly one match → pressing Enter commits the selection and closes
  // the dropdown.
  await subFilterInput.press("Enter");

  // The trigger should now display the selected category.
  await expect(trigger).toContainText(TEST_CATEGORY);

  // Reload and verify the change persisted to the backend.
  await page.reload();

  // Re-open Chase Sapphire Preferred after reload (auto-opens Platinum Card).
  const cspSectionAfterReload = page.locator("section").filter({
    has: page.getByText("Chase Sapphire Preferred"),
  });
  const cspTableAfterReload = cspSectionAfterReload.locator("table");
  if (!await cspTableAfterReload.isVisible()) {
    await cspSectionAfterReload.locator("button").first().click();
    await expect(cspTableAfterReload).toBeVisible();
  }

  const rowAfterReload = page.locator(`tr[data-testid='txn-row-${TXN_ID}']`);
  await rowAfterReload.scrollIntoViewIfNeeded();
  await expect(
    rowAfterReload.locator("[data-testid='category-trigger']"),
  ).toContainText(TEST_CATEGORY);
});

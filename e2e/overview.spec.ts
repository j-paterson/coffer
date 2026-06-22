import { test, expect } from "@playwright/test";

test("#1 overview page loads and displays net worth", async ({ page }) => {
  // Ensure privacy mode is off so dollar amounts are visible.
  await page.addInitScript(() => {
    window.localStorage.setItem("finance.privacyMode", "off");
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();

  const label = page.getByTestId("net-worth-label");
  await expect(label).toHaveText("Net worth");

  const value = page.getByTestId("net-worth-value");
  await expect(value).toBeVisible();
  const text = await value.textContent();
  expect(text).toBeTruthy();
  expect(text).toContain("$");
});

test("#2 account list renders with expected sections", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();

  const sectionHeaders = page.locator("h2");
  const count = await sectionHeaders.count();
  expect(count).toBeGreaterThan(0);

  const knownSections = ["Checking", "Savings", "Credit cards", "Crypto", "Brokerage", "Retirement"];
  let found = false;
  for (const name of knownSections) {
    const header = page.getByRole("heading", { name, level: 2 });
    if ((await header.count()) > 0) {
      found = true;
      break;
    }
  }
  expect(found, "at least one known account section should exist").toBe(true);
});

test("#3 navigation: Overview → Transactions → Spending → Projections → back", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();

  await page.getByRole("link", { name: "Transactions" }).click();
  await expect(page.getByRole("heading", { name: "Transactions" })).toBeVisible();

  await page.getByRole("link", { name: "Spending" }).click();
  await expect(page.getByRole("heading", { name: "Spending" })).toBeVisible();

  await page.getByRole("link", { name: "Projections" }).click();
  await expect(page.getByRole("heading", { name: "Projections" })).toBeVisible();

  await page.getByRole("link", { name: "Overview" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
});

test("#4 account selection: clicking an account filters the view", async ({ page }) => {
  // Ensure privacy mode is off so dollar amounts are visible.
  await page.addInitScript(() => {
    window.localStorage.setItem("finance.privacyMode", "off");
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();

  await expect(page.getByTestId("net-worth-label")).toHaveText("Net worth");

  // Account rows are <li> elements inside <ul class="divide-y ...">
  // The clickable element inside each <li> is a <div> (not a <button>).
  const accountRow = page.locator("ul.divide-y li").first();
  await expect(accountRow).toBeVisible();

  await accountRow.click();

  const label = page.getByTestId("net-worth-label");
  await expect(label).not.toHaveText("Net worth");
  const labelText = await label.textContent();
  expect(labelText).toBeTruthy();
  expect(labelText).not.toBe("Net worth");

  // Click the "Net worth" row at the top to deselect.
  await page.getByText("Net worth", { exact: true }).first().click();
  await expect(page.getByTestId("net-worth-label")).toHaveText("Net worth");
});

import { test, expect } from "@playwright/test";
import { makeEvent, interceptSseOnce, resetSeq, type SyncEventData } from "./helpers/sse";
import { interceptSyncRoutes } from "./helpers/syncRoutes";

const BUTTONS = [
  { testId: "sync-all-btn", title: "Pull latest data from every parser, sequentially" },
  { testId: "sync-simplefin-btn", title: "Sync SimpleFIN only (banks, cards)" },
  { testId: "sync-zerion-btn", title: "Sync Zerion only (crypto wallets)" },
  { testId: "sync-defillama-btn", title: "Sync DefiLlama prices for tracked crypto positions" },
  { testId: "sync-alchemy-btn", title: "Sync Alchemy on-chain balances" },
  { testId: "sync-geckoterminal-btn", title: "Sync GeckoTerminal pool prices" },
  { testId: "sync-coinbase-btn", title: "Sync Coinbase exchange balances" },
];

test.beforeEach(() => resetSeq());

test("#1 all sync buttons present with correct titles", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();

  for (const { testId, title } of BUTTONS) {
    const btn = page.getByTestId(testId);
    await expect(btn).toBeVisible();
    await expect(btn).toHaveAttribute("title", title);
  }
});

test("#2 single parser trigger: click → POST → disable → SSE → re-enable", async ({ page }) => {
  const events: SyncEventData[] = [
    makeEvent("sync_started", { sources: ["defillama"] }),
    makeEvent("account_started", { account_id: "defi-prices", source: "defillama" }),
    makeEvent("account_finished", { account_id: "defi-prices", ok: true }),
    makeEvent("sync_finished", { ok: true, totals: {} }),
  ];
  await interceptSseOnce(page, events);
  const ctrl = await interceptSyncRoutes(page);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();

  await page.getByTestId("sync-defillama-btn").click();

  expect(ctrl.posts.some((p) => p.parser === "defillama")).toBe(true);

  // Since all events are delivered at once (batch fulfill), the reducer
  // processes sync_started then sync_finished synchronously — final state
  // is running=false. Buttons should be enabled.
  await expect(page.getByTestId("sync-all-btn")).toBeEnabled();
  await expect(page.getByTestId("sync-all-btn")).toContainText("sync all");
});

test("#3 SSE events populate debug log panel", async ({ page }) => {
  const events: SyncEventData[] = [
    makeEvent("sync_started", { sources: ["defillama"] }),
    makeEvent("account_started", { account_id: "defi-prices", source: "defillama" }),
    makeEvent("account_log", { account_id: "defi-prices", message: "fetching prices", level: "info" }),
    makeEvent("account_finished", { account_id: "defi-prices", ok: true }),
    makeEvent("sync_finished", { ok: true, totals: {} }),
  ];
  await interceptSseOnce(page, events);
  await interceptSyncRoutes(page);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible({ timeout: 15_000 });

  await page.getByTestId("sync-defillama-btn").click();

  const log = page.getByTestId("sync-debug-log");
  await expect(log).toBeVisible();

  await expect(page.getByTestId("sync-debug-log-status")).toHaveText("ok");

  await page.getByTestId("sync-debug-log-toggle").click();

  const logList = log.locator("ol li");
  await expect(logList).toHaveCount(5);
  await expect(logList.nth(0)).toContainText("sync started");
  await expect(logList.nth(1)).toContainText("defi-prices");
  await expect(logList.nth(2)).toContainText("fetching prices");
  await expect(logList.nth(3)).toContainText("finished");
  await expect(logList.nth(4)).toContainText("sync finished");
});

test("#4 sync failure shows error state in debug log", async ({ page }) => {
  const events: SyncEventData[] = [
    makeEvent("sync_started", { sources: ["defillama"] }),
    makeEvent("account_started", { account_id: "defi-prices", source: "defillama" }),
    makeEvent("account_finished", { account_id: "defi-prices", ok: false }),
    makeEvent("sync_finished", { ok: false, totals: {} }),
  ];
  await interceptSseOnce(page, events);
  await interceptSyncRoutes(page);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();

  await page.getByTestId("sync-defillama-btn").click();

  const badge = page.getByTestId("sync-debug-log-status");
  await expect(badge).toHaveText("failed");
  await expect(badge).toHaveClass(/bg-rose-100/);
});

test("#5 buttons disabled while sync is running", async ({ page }) => {
  // interceptSseOnce delivers sync_started immediately when EventSource connects
  // on mount (before any button click). So by the time the page is loaded, the
  // SSE has already put the app into running=true state, disabling all buttons.
  const events: SyncEventData[] = [
    makeEvent("sync_started", { sources: ["defillama"] }),
  ];
  await interceptSseOnce(page, events);
  await interceptSyncRoutes(page);

  await page.goto("/");
  // The heading only appears after accounts/summary load AND after the component
  // re-renders. Wait for the sync-all-btn to appear and be disabled first.
  await expect(page.getByTestId("sync-all-btn")).toBeDisabled({ timeout: 15_000 });

  for (const { testId } of BUTTONS) {
    await expect(page.getByTestId(testId)).toBeDisabled();
  }

  await expect(page.getByTestId("sync-all-btn")).toContainText("syncing…");
});

test("#6 sync all triggers sequential POST to each parser", async ({ page }) => {
  const SYNC_ORDER = ["simplefin", "defillama", "zerion", "alchemy", "geckoterminal", "coinbase"] as const;

  const sseEvents: SyncEventData[] = [
    makeEvent("sync_started", { sources: [...SYNC_ORDER] }),
  ];
  for (const parser of SYNC_ORDER) {
    sseEvents.push(makeEvent("account_started", { account_id: `${parser}-acct`, source: parser }));
    sseEvents.push(makeEvent("account_finished", { account_id: `${parser}-acct`, ok: true }));
  }
  sseEvents.push(makeEvent("sync_finished", { ok: true, totals: {} }));

  await interceptSseOnce(page, sseEvents);
  const ctrl = await interceptSyncRoutes(page);

  let currentParserId = "";
  page.on("request", (req) => {
    if (!req.url().includes("/api/sync/runs")) return;
    const lastPost = ctrl.posts[ctrl.posts.length - 1];
    if (!lastPost) {
      ctrl.setRunsResponse({ current: null, history: [] });
      return;
    }
    if (currentParserId !== lastPost.parser) {
      currentParserId = lastPost.parser;
      ctrl.setRunsResponse({
        current: {
          run_id: `test-${lastPost.parser}`,
          started_at: new Date().toISOString(),
          finished_at: null,
          ok: null,
          events: [],
        },
        history: [],
      });
      setTimeout(() => {
        ctrl.setRunsResponse({ current: null, history: [] });
      }, 200);
    }
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();

  await page.getByTestId("sync-all-btn").click();

  await expect.poll(
    () => ctrl.posts.length,
    { timeout: 30_000, message: "waiting for all 6 sync POSTs" },
  ).toBe(6);

  const postOrder = ctrl.posts.map((p) => p.parser);
  expect(postOrder).toEqual([...SYNC_ORDER]);

  await expect(page.getByTestId("sync-all-btn")).toBeEnabled({ timeout: 5_000 });
  await expect(page.getByTestId("sync-all-btn")).toContainText("sync all");
});

import type { Page } from "@playwright/test";

const PARSERS = [
  "simplefin",
  "defillama",
  "zerion",
  "alchemy",
  "geckoterminal",
  "coinbase",
] as const;

export type ParserId = (typeof PARSERS)[number];

export type PostLog = { parser: ParserId; url: string; timestamp: number };

export type SyncRouteController = {
  posts: PostLog[];
  setRunsResponse: (body: unknown) => void;
};

export async function interceptSyncRoutes(
  page: Page,
  options: { conflict?: ParserId[] } = {},
): Promise<SyncRouteController> {
  const posts: PostLog[] = [];
  let runsBody: unknown = { current: null, history: [] };

  for (const parser of PARSERS) {
    const pattern = `**/api/sync/${parser}**`;
    await page.route(pattern, async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      posts.push({
        parser,
        url: route.request().url(),
        timestamp: Date.now(),
      });
      if (options.conflict?.includes(parser)) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: "different sync already in progress" }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ run_id: `test-${parser}` }),
        });
      }
    });
  }

  await page.route("**/api/sync/runs", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(runsBody),
    });
  });

  return {
    posts,
    setRunsResponse(body: unknown) {
      runsBody = body;
    },
  };
}

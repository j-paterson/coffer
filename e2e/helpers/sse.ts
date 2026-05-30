import type { Page } from "@playwright/test";

export type SyncEventData = {
  type: string;
  ts?: string;
  seq?: number;
  run_id?: string;
  [key: string]: unknown;
};

let seqCounter = 0;

export function resetSeq(): void {
  seqCounter = 0;
}

export function makeEvent(
  type: string,
  fields: Record<string, unknown> = {},
  runId = "test-run-1",
): SyncEventData {
  seqCounter += 1;
  return {
    type,
    ts: new Date().toISOString(),
    seq: seqCounter,
    run_id: runId,
    ...fields,
  };
}

export async function interceptSseOnce(
  page: Page,
  events: SyncEventData[],
): Promise<void> {
  let fulfilled = false;
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  await page.route("**/api/sync/stream", async (route) => {
    if (fulfilled) {
      await route.continue();
      return;
    }
    fulfilled = true;
    await route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
      body,
    });
  });
}

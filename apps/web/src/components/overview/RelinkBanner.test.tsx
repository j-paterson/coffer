// apps/web/src/components/overview/RelinkBanner.test.tsx
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RelinkBanner } from "./RelinkBanner";

const PLAN = {
  pairs: [
    {
      canonical: "simplefin:old",
      alias: "simplefin:new",
      label: "Northwind Bank · Rewards Card (1234)",
      duplicates: [{ txn_id: 2, keeper_txn_id: 1, date: "2026-09-10", description: "CAFE", amount: -20 }],
      needs_review: [],
      unmatched: 0,
    },
  ],
  ambiguous: [],
};

vi.mock("../../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../lib/api")>("../../lib/api");
  return {
    ...actual,
    api: {
      ...actual.api,
      relinkPlan: vi.fn(),
      applyRelink: vi.fn().mockResolvedValue({
        backup: "/data/backups/finance-pre-relink.sqlite",
        merged: [{ canonical: "simplefin:old", alias: "simplefin:new", removed: 1 }],
      }),
    },
  };
});

afterEach(cleanup);

function renderWithClient(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

test("renders nothing when there is nothing to relink", async () => {
  const { api } = await import("../../lib/api");
  (api.relinkPlan as ReturnType<typeof vi.fn>).mockResolvedValue({ pairs: [], ambiguous: [] });
  const { container } = renderWithClient(<RelinkBanner />);
  await new Promise((r) => setTimeout(r, 0));
  expect(container.innerHTML).toBe("");
});

test("merges only after review + confirm, sending the reviewed aliases", async () => {
  const { api } = await import("../../lib/api");
  (api.relinkPlan as ReturnType<typeof vi.fn>).mockResolvedValue(PLAN);
  renderWithClient(<RelinkBanner />);
  fireEvent.click(await screen.findByRole("button", { name: "Review & merge" }));
  expect(api.applyRelink).not.toHaveBeenCalled();
  expect(screen.getByText("CAFE")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Merge 1 and remove 1 duplicates/ }));
  expect(await screen.findByText(/finance-pre-relink\.sqlite/)).toBeTruthy();
  expect(api.applyRelink).toHaveBeenCalledWith(["simplefin:new"], 1);
});

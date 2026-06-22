// apps/web/src/components/ProviderCardList.test.tsx
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProviderCardList } from "./ProviderCardList";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, api: { ...actual.api, connections: vi.fn().mockResolvedValue([]) } };
});

afterEach(cleanup);

function renderWithClient(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

test("renders a card per provider with a Connect action for an unconnected auth provider", () => {
  renderWithClient(<ProviderCardList />);
  expect(screen.getByText("SimpleFIN (banks & cards)")).toBeTruthy();
  expect(screen.getByText("Coinbase (exchange)")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "Connect" }).length).toBeGreaterThan(0);
});

test("a connected auth provider shows an Edit button", async () => {
  const { api } = await import("../lib/api");
  (api.connections as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: "zerion", label: "Zerion (crypto wallets)", needsAuth: true, enabled: true, status: "connected", connected: true, last_connected_at: null, config: { wallets: ["0xabc"] }, configuredSecrets: ["ZERION_API_KEY"] },
  ]);
  renderWithClient(<ProviderCardList />);
  expect(await screen.findByRole("button", { name: "Edit" })).toBeTruthy();
});

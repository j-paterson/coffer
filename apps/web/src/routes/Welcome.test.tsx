// apps/web/src/routes/Welcome.test.tsx
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const navigateSpy = vi.fn();
vi.mock("react-router-dom", () => ({ useNavigate: () => navigateSpy }));
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    api: { ...actual.api, accounts: vi.fn().mockResolvedValue([]), connections: vi.fn().mockResolvedValue([]) },
  };
});

import { Welcome } from "./Welcome";

beforeEach(() => { localStorage.clear(); navigateSpy.mockClear(); });
afterEach(cleanup);

function renderWelcome() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><Welcome /></QueryClientProvider>);
}

test("Next/Back move through steps", () => {
  renderWelcome();
  expect(screen.getByText("Welcome to Coffer")).toBeTruthy();        // step 1
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getByText("Connect providers")).toBeTruthy();         // step 2
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.getByText("Welcome to Coffer")).toBeTruthy();         // back to 1
});

test("Skip for now sets the onboarded flag and navigates home", () => {
  renderWelcome();
  fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
  expect(localStorage.getItem("finance.onboarded")).toBe("1");
  expect(navigateSpy).toHaveBeenCalledWith("/", { replace: true });
});

test("Go to dashboard on step 4 sets the onboarded flag and navigates home", () => {
  renderWelcome();
  fireEvent.click(screen.getByRole("button", { name: "Next" })); // step 1 → 2
  fireEvent.click(screen.getByRole("button", { name: "Next" })); // step 2 → 3
  fireEvent.click(screen.getByRole("button", { name: "Next" })); // step 3 → 4
  expect(screen.getByText("You're all set")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Go to dashboard" }));
  expect(localStorage.getItem("finance.onboarded")).toBe("1");
  expect(navigateSpy).toHaveBeenCalledWith("/", { replace: true });
});

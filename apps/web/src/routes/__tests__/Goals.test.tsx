import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Goal } from "../../../../../packages/shared/types";
import { Goals } from "../Goals";
import { PrivacyProvider } from "../../lib/privacy";

vi.mock("../../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../lib/api")>("../../lib/api");
  return {
    ...actual,
    api: {
      ...actual.api,
      goals: {
        list: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        allocate: vi.fn(),
        archive: vi.fn(),
        delete: vi.fn(),
      },
    },
  };
});

import { api } from "../../lib/api";

const mockApi = api as unknown as {
  goals: {
    list: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    allocate: ReturnType<typeof vi.fn>;
    archive: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
};

function makeGoal(over: Partial<Goal> = {}): Goal {
  return {
    id: 1,
    name: "Property tax",
    target_amount: 13000,
    allocated_amount: 7200,
    due_date: "2026-10-01",
    created_at: "2026-05-05 00:00:00",
    completed_at: null,
    pct_funded: 55,
    is_funded: false,
    monthly_pace: 1160,
    ...over,
  };
}

function renderGoals() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PrivacyProvider>
        <Goals />
      </PrivacyProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Object.values(mockApi.goals).forEach((fn) => fn.mockReset());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Goals page", () => {
  test("renders empty state when no goals", async () => {
    mockApi.goals.list.mockResolvedValue({ goals: [] });
    renderGoals();
    expect(await screen.findByText("Set your first savings goal")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create a goal/i })).toBeInTheDocument();
  });

  test("renders card grid with totals", async () => {
    mockApi.goals.list.mockResolvedValue({
      goals: [
        makeGoal(),
        makeGoal({ id: 2, name: "AC repair", target_amount: 10000, allocated_amount: 4000, due_date: null, pct_funded: 40, monthly_pace: undefined }),
      ],
    });
    renderGoals();
    expect(await screen.findByText("Property tax")).toBeInTheDocument();
    expect(screen.getByText("AC repair")).toBeInTheDocument();
    expect(screen.getByText(/across 2 goals/i)).toBeInTheDocument();
  });

  test("opening Add modal and submitting calls allocate with positive amount", async () => {
    mockApi.goals.list.mockResolvedValue({ goals: [makeGoal()] });
    mockApi.goals.allocate.mockResolvedValue(makeGoal({ allocated_amount: 7300 }));
    const user = userEvent.setup();
    renderGoals();
    await screen.findByText("Property tax");
    await user.click(screen.getByRole("button", { name: "Add" }));
    const dialog = await screen.findByRole("dialog", { name: /add to "property tax"/i });
    const input = dialog.querySelector('input[type="number"]') as HTMLInputElement;
    await user.type(input, "100");
    await user.click(dialog.querySelector('button[type="submit"]')!);
    await waitFor(() => {
      expect(mockApi.goals.allocate).toHaveBeenCalledWith(1, 100);
    });
  });

  test("Drawn down submits negated amount", async () => {
    mockApi.goals.list.mockResolvedValue({ goals: [makeGoal()] });
    mockApi.goals.allocate.mockResolvedValue(makeGoal({ allocated_amount: 7100 }));
    const user = userEvent.setup();
    renderGoals();
    await screen.findByText("Property tax");
    await user.click(screen.getByRole("button", { name: /drawn down/i }));
    const dialog = await screen.findByRole("dialog", { name: /drawn down from "property tax"/i });
    const input = dialog.querySelector('input[type="number"]') as HTMLInputElement;
    await user.type(input, "100");
    await user.click(dialog.querySelector('button[type="submit"]')!);
    await waitFor(() => {
      expect(mockApi.goals.allocate).toHaveBeenCalledWith(1, -100);
    });
  });

  test("opening New goal modal and submitting calls create", async () => {
    mockApi.goals.list.mockResolvedValue({ goals: [makeGoal()] });
    mockApi.goals.create.mockResolvedValue(makeGoal({ id: 2, name: "Vacation" }));
    const user = userEvent.setup();
    renderGoals();
    await screen.findByText("Property tax");
    await user.click(screen.getByRole("button", { name: /new goal/i }));
    const dialog = await screen.findByRole("dialog", { name: /new goal/i });
    await user.type(dialog.querySelector('input[type="text"]') as HTMLInputElement, "Vacation");
    await user.type(dialog.querySelector('input[type="number"]') as HTMLInputElement, "5000");
    await user.click(dialog.querySelector('button[type="submit"]')!);
    await waitFor(() => {
      expect(mockApi.goals.create).toHaveBeenCalledWith({
        name: "Vacation",
        target_amount: 5000,
        due_date: null,
      });
    });
  });

  test("toggling Show archived refetches with includeArchived=true", async () => {
    mockApi.goals.list.mockResolvedValue({ goals: [makeGoal()] });
    const user = userEvent.setup();
    renderGoals();
    await screen.findByText("Property tax");
    await user.click(screen.getByRole("checkbox", { name: /show archived/i }));
    await waitFor(() => {
      expect(mockApi.goals.list).toHaveBeenCalledWith(true);
    });
  });
});

// apps/web/src/routes/projections/_shell/__tests__/ProjectionsLayout.test.tsx

import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, test } from "vitest";
import { ProjectionsLayout } from "../ProjectionsLayout";

function mount(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/projections" element={<ProjectionsLayout />}>
          <Route index element={<div>INDEX</div>} />
          <Route path="heloc" element={<div>HELOC</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("ProjectionsLayout", () => {
  test("hides the per-projection nav on the index", () => {
    mount("/projections");
    expect(screen.getByText("INDEX")).toBeInTheDocument();
    expect(screen.queryByText("HELOC")).not.toBeInTheDocument();
  });

  test("shows the per-projection nav on a sub-route", () => {
    mount("/projections/heloc");
    expect(screen.getAllByText("HELOC").length).toBeGreaterThan(0);
    expect(screen.getByText("Retirement")).toBeInTheDocument();
    expect(screen.getByText("Mortgage")).toBeInTheDocument();
  });

  test("exposes a #projection-toolbar portal target", () => {
    mount("/projections/heloc");
    expect(document.getElementById("projection-toolbar")).not.toBeNull();
  });
});

// apps/web/src/routes/projections/_shell/__tests__/ProjectionsIndex.test.tsx

import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, test } from "vitest";
import { ProjectionsIndex } from "../ProjectionsIndex";
import { projections } from "../projectionRegistry";

describe("ProjectionsIndex", () => {
  test("renders one card per projection", () => {
    render(
      <MemoryRouter>
        <ProjectionsIndex />
      </MemoryRouter>,
    );
    for (const p of projections) {
      expect(screen.getByText(p.title)).toBeInTheDocument();
      expect(screen.getByText(p.blurb)).toBeInTheDocument();
    }
  });

  test("only ready projections lack a 'Coming soon' badge", () => {
    render(
      <MemoryRouter>
        <ProjectionsIndex />
      </MemoryRouter>,
    );
    const badges = screen.getAllByText("Coming soon");
    const expected = projections.filter((p) => p.status === "coming-soon").length;
    expect(badges.length).toBe(expected);
  });
});

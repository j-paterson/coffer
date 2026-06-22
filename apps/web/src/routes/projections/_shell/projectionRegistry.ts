// apps/web/src/routes/projections/_shell/projectionRegistry.ts

export type ProjectionStatus = "ready" | "coming-soon";

export type ProjectionMeta = {
  slug: "heloc" | "retirement" | "mortgage";
  title: string;
  blurb: string;
  status: ProjectionStatus;
};

export const projections: ProjectionMeta[] = [
  {
    slug: "heloc",
    title: "HELOC",
    blurb: "Borrow against home equity to invest.",
    status: "ready",
  },
  {
    slug: "retirement",
    title: "Retirement",
    blurb: "Model retirement income and FIRE scenarios.",
    status: "coming-soon",
  },
  {
    slug: "mortgage",
    title: "Mortgage",
    blurb: "Compare payoff vs refinance options.",
    status: "coming-soon",
  },
];

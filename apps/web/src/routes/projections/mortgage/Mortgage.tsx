// apps/web/src/routes/projections/mortgage/Mortgage.tsx

import { projections } from "../_shell/projectionRegistry";

export function Mortgage() {
  const meta = projections.find((p) => p.slug === "mortgage")!;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-semibold text-stone-900">{meta.title}</h2>
        <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-600">
          Coming soon
        </span>
      </div>
      <p className="text-sm text-stone-500">{meta.blurb}</p>
      <p className="text-sm text-stone-600">
        This projection is not built yet. It will compare aggressive payoff,
        refinance, and as-scheduled paths against each other.
      </p>
    </div>
  );
}

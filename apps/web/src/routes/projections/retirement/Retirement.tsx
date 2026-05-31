// apps/web/src/routes/projections/retirement/Retirement.tsx

import { projections } from "../_shell/projectionRegistry";

export function Retirement() {
  const meta = projections.find((p) => p.slug === "retirement")!;
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
        This projection is not built yet. It will let you model contribution
        accounts, withdrawal phases, and tax treatment across pre-tax and Roth
        buckets.
      </p>
    </div>
  );
}

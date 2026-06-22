// apps/web/src/routes/projections/_shell/ProjectionCard.tsx

import { Link } from "react-router-dom";
import type { ProjectionMeta } from "./projectionRegistry";

export function ProjectionCard({ meta }: { meta: ProjectionMeta }) {
  const ready = meta.status === "ready";
  return (
    <Link
      to={`/projections/${meta.slug}`}
      className="flex flex-col gap-3 rounded-lg border border-stone-200 bg-white p-5 transition-colors hover:border-stone-300 hover:bg-stone-50"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-lg font-semibold text-stone-900">{meta.title}</h3>
        {!ready && (
          <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs font-medium text-stone-600">
            Coming soon
          </span>
        )}
      </div>
      <p className="text-sm text-stone-600">{meta.blurb}</p>
      <div className="mt-auto text-sm font-medium text-stone-700">
        {ready ? "Configure →" : "Preview →"}
      </div>
    </Link>
  );
}

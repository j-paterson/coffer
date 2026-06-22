// apps/web/src/routes/projections/_shell/ProjectionsIndex.tsx

import { ProjectionCard } from "./ProjectionCard";
import { projections } from "./projectionRegistry";

export function ProjectionsIndex() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-stone-900">Projections</h1>
        <p className="text-sm text-stone-500">
          Model long-term financial decisions. Pick a projection to get started.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {projections.map((p) => (
          <ProjectionCard key={p.slug} meta={p} />
        ))}
      </div>
    </div>
  );
}

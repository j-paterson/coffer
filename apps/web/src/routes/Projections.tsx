import { useScenario } from "./projections/useScenario";
import { LoanCard } from "./projections/LoanCard";
import { MarketCard } from "./projections/MarketCard";
import { CompositionCard } from "./projections/CompositionCard";
import { TaxCard } from "./projections/TaxCard";
import { StressCard } from "./projections/StressCard";
import { CompareCard } from "./projections/CompareCard";
import { HeadlineCards } from "./projections/HeadlineCards";
import { NetWorthChart } from "./projections/NetWorthChart";
import { DeltaChart } from "./projections/DeltaChart";
import { TaxProfileModal } from "./projections/TaxProfileModal";
import { SaveScenarioBar } from "./projections/SaveScenarioBar";
import { AdvisorPanel } from "./projections/AdvisorPanel";

export function Projections() {
  const { prefill, scenario, setScenario, runResult, isPending } = useScenario();

  if (prefill && !prefill.ok && prefill.requiresHome) {
    return (
      <EmptyState title="Home not found" message="Add your home as a manual account in Kubera so the sandbox can use it." />
    );
  }
  if (prefill && !prefill.ok && prefill.requiresTaxProfile) {
    return <TaxProfileModal onSaved={() => window.location.reload()} onCancel={() => {}} />;
  }
  if (!scenario || !runResult) {
    return <div className="text-sm text-stone-500">Loading projections…</div>;
  }

  return (
    <div className="flex h-full flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-stone-900">Projections</h1>
          <p className="text-sm text-stone-500">Model borrowing against home equity to invest.</p>
        </div>
        <SaveScenarioBar scenario={scenario} onLoaded={(s) => setScenario(() => s)} />
      </div>
      <div className="grid grid-cols-[320px_1fr] gap-6">
        <aside className="flex flex-col gap-3">
          <LoanCard scenario={scenario} onChange={setScenario} />
          <MarketCard scenario={scenario} onChange={setScenario} />
          <CompositionCard scenario={scenario} onChange={setScenario} />
          <TaxCard scenario={scenario} onChange={setScenario} />
          <StressCard scenario={scenario} onChange={setScenario} />
          <CompareCard />
        </aside>
        <section className="flex flex-col gap-4">
          <HeadlineCards summary={runResult.summary} />
          <NetWorthChart timeline={runResult.timeline} comparison={runResult.comparison} showMC={scenario.mc.enabled} startDate={scenario.startDate} />
          <DeltaChart timeline={runResult.timeline} comparison={runResult.comparison} startDate={scenario.startDate} />
          <AdvisorPanel scenario={scenario} runResult={runResult} />
          {isPending && <div className="text-xs text-stone-400">recomputing…</div>}
        </section>
      </div>
    </div>
  );
}

function EmptyState({ title, message }: { title: string; message: string }) {
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="rounded-md border border-stone-200 bg-white p-6 text-center text-stone-700">
        <div className="text-lg font-semibold">{title}</div>
        <p className="mt-1 text-sm text-stone-500">{message}</p>
      </div>
    </div>
  );
}

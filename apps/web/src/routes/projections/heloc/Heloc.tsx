// apps/web/src/routes/projections/heloc/Heloc.tsx

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useScenario } from "./useScenario";
import { LoanCard } from "./LoanCard";
import { MarketCard } from "./MarketCard";
import { CompositionCard } from "./CompositionCard";
import { TaxCard } from "./TaxCard";
import { StressCard } from "./StressCard";
import { CompareCard } from "./CompareCard";
import { HeadlineCards } from "./HeadlineCards";
import { NetWorthChart } from "./NetWorthChart";
import { DeltaChart } from "./DeltaChart";
import { TaxProfileModal } from "./TaxProfileModal";
import { HomeSetupModal } from "./HomeSetupModal";
import { SaveScenarioBar } from "./SaveScenarioBar";
import { AdvisorPanel } from "./AdvisorPanel";

export function Heloc() {
  const { prefill, scenario, setScenario, runResult, isPending } = useScenario();
  const qc = useQueryClient();
  const [toolbarEl, setToolbarEl] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setToolbarEl(document.getElementById("projection-toolbar"));
  }, []);

  if (prefill && !prefill.ok && prefill.requiresHome) {
    return <HomeSetupModal onSaved={() => qc.invalidateQueries({ queryKey: ["prefill"] })} />;
  }
  if (prefill && !prefill.ok && prefill.requiresTaxProfile) {
    return <TaxProfileModal onSaved={() => window.location.reload()} onCancel={() => {}} />;
  }
  if (!scenario || !runResult) {
    return <div className="text-sm text-stone-500">Loading projections…</div>;
  }

  return (
    <div className="flex h-full flex-col gap-6">
      {toolbarEl &&
        createPortal(
          <SaveScenarioBar scenario={scenario} onLoaded={(s) => setScenario(() => s)} />,
          toolbarEl,
        )}
      <div>
        <p className="text-sm text-stone-500">Model borrowing against home equity to invest.</p>
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

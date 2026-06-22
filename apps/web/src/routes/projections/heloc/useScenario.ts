import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Scenario, ProjectionRunResponse, PrefillResponse } from "../../../../../../packages/shared/types";

const API = "";

async function getPrefill(): Promise<PrefillResponse> {
  const r = await fetch(`${API}/api/projections/prefill`);
  return r.json();
}

async function runScenario(body: { scenario: Scenario; compareTo?: Scenario }): Promise<ProjectionRunResponse> {
  const r = await fetch(`${API}/api/projections/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`run failed: ${r.status}`);
  return r.json();
}

function encodeState(s: Scenario): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(s))));
}
function decodeState(s: string): Scenario | null {
  try {
    return JSON.parse(decodeURIComponent(escape(atob(s))));
  } catch {
    return null;
  }
}

export function useScenario() {
  const prefillQ = useQuery({ queryKey: ["prefill"], queryFn: getPrefill });
  const [scenario, setScenarioRaw] = useState<Scenario | null>(null);

  useEffect(() => {
    if (scenario) return;
    const hash = window.location.hash.replace(/^#/, "");
    if (hash) {
      const decoded = decodeState(hash);
      if (decoded) {
        setScenarioRaw(decoded);
        return;
      }
    }
    if (prefillQ.data && prefillQ.data.ok) {
      setScenarioRaw(prefillQ.data.scenario);
    }
  }, [prefillQ.data, scenario]);

  const tRef = useRef<number | null>(null);
  useEffect(() => {
    if (!scenario) return;
    if (tRef.current) window.clearTimeout(tRef.current);
    tRef.current = window.setTimeout(() => {
      window.history.replaceState(null, "", `#${encodeState(scenario)}`);
    }, 150);
    return () => { if (tRef.current) window.clearTimeout(tRef.current); };
  }, [scenario]);

  const [runResult, setRunResult] = useState<ProjectionRunResponse | null>(null);
  const [isPending, setPending] = useState(false);
  const runTRef = useRef<number | null>(null);
  useEffect(() => {
    if (!scenario) return;
    if (runTRef.current) window.clearTimeout(runTRef.current);
    runTRef.current = window.setTimeout(async () => {
      setPending(true);
      try {
        const compareTo: Scenario = { ...scenario, events: [] };
        const res = await runScenario({ scenario, compareTo });
        setRunResult(res);
      } finally {
        setPending(false);
      }
    }, 200);
    return () => { if (runTRef.current) window.clearTimeout(runTRef.current); };
  }, [scenario]);

  function setScenario(updater: (s: Scenario) => Scenario) {
    setScenarioRaw((prev) => (prev ? updater(prev) : prev));
  }

  return { prefill: prefillQ.data, scenario, setScenario, runResult, isPending };
}

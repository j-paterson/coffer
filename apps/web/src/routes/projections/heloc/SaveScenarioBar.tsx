import { useState } from "react";
import type { Scenario } from "../../../../../../packages/shared/types";

export function SaveScenarioBar({ scenario, onLoaded }: { scenario: Scenario; onLoaded: (s: Scenario) => void }) {
  const [name, setName] = useState(scenario.name ?? "");
  const [saved, setSaved] = useState<{ id: string; name: string }[]>([]);
  async function save() {
    const res = await fetch("/api/projections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenario: { ...scenario, name } }),
    }).then((r) => r.json());
    await refresh();
    return res;
  }
  async function refresh() {
    const list = await fetch("/api/projections").then((r) => r.json());
    setSaved(list.scenarios);
  }
  async function load(id: string) {
    const res = await fetch(`/api/projections/${id}`).then((r) => r.json());
    onLoaded({ ...scenario, ...res.scenario });
  }
  return (
    <div className="flex items-center gap-2">
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Scenario name" className="flex-1 rounded border border-stone-200 px-2 py-1 text-sm" />
      <button onClick={save} className="rounded border border-stone-200 px-3 py-1 text-sm">Save</button>
      <button onClick={refresh} className="rounded border border-stone-200 px-3 py-1 text-sm">My scenarios</button>
      {saved.length > 0 && (
        <select onChange={(e) => load(e.target.value)} className="rounded border border-stone-200 px-2 py-1 text-sm">
          <option>—</option>
          {saved.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      )}
    </div>
  );
}

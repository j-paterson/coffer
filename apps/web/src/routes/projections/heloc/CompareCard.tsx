export function CompareCard() {
  return (
    <div className="rounded-md border border-stone-200 bg-white p-4">
      <div className="mb-3 text-sm font-semibold text-stone-900">Compare to</div>
      <select className="w-full rounded border border-stone-200 px-2 py-1 text-sm" disabled defaultValue="nothing">
        <option value="nothing">Do nothing (default)</option>
      </select>
      <p className="mt-2 text-xs text-stone-500">
        Additional comparison scenarios are on the roadmap.
      </p>
    </div>
  );
}

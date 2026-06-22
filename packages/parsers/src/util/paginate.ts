export interface PageAdapter<TRecord, TCursor> {
  initial: TCursor | null;
  fetchPage(cursor: TCursor | null): Promise<{
    records: TRecord[];
    next: TCursor | null;
  }>;
}

export async function* paginate<R, C>(
  adapter: PageAdapter<R, C>,
): AsyncIterable<R> {
  let cursor = adapter.initial;
  while (true) {
    const { records, next } = await adapter.fetchPage(cursor);
    for (const r of records) yield r;
    if (next === null) return;
    cursor = next;
  }
}

export class SchemaOutdatedError extends Error {
  constructor(missingTable: string | null) {
    const detail = missingTable ? ` (missing table: ${missingTable})` : "";
    super(`schema appears outdated${detail} — run \`finance migrate\``);
    this.name = "SchemaOutdatedError";
  }
}

export function rewrapSchemaError(e: unknown): Error {
  if (!(e instanceof Error)) return new Error(String(e));
  const msg = e.message ?? "";
  const m = /no such table:?\s*(\w+)/i.exec(msg);
  if (m) return new SchemaOutdatedError(m[1] ?? null);
  return e;
}

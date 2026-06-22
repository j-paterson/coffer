export type DateFormat = "YYYY-MM-DD" | "MM/DD/YYYY" | "DD/MM/YYYY";

const ISO_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const SLASH_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function isValidDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

/** Parse a date string in the given format and return ISO `YYYY-MM-DD`. */
export function parseDate(raw: string, format: DateFormat): string {
  const s = raw.trim();
  let y: number, m: number, d: number;
  if (format === "YYYY-MM-DD") {
    const match = ISO_RE.exec(s);
    if (!match) throw new Error(`parseDate: ${JSON.stringify(raw)} doesn't match YYYY-MM-DD`);
    y = Number(match[1]!); m = Number(match[2]!); d = Number(match[3]!);
  } else {
    const match = SLASH_RE.exec(s);
    if (!match) throw new Error(`parseDate: ${JSON.stringify(raw)} doesn't match ${format}`);
    const a = Number(match[1]!); const b = Number(match[2]!); y = Number(match[3]!);
    if (format === "MM/DD/YYYY") { m = a; d = b; }
    else { d = a; m = b; }
  }
  if (!isValidDate(y, m, d)) {
    throw new Error(`parseDate: ${JSON.stringify(raw)} is not a real calendar date`);
  }
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

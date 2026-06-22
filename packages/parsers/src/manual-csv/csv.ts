export interface CsvRow {
  /** 1-based, counting only data rows (header excluded). */
  lineNumber: number;
  fields: string[];
}

export interface ParsedCsv {
  header: string[];
  rows: CsvRow[];
}

/** RFC-4180 reader. Handles quoted fields, escaped quotes (""),
 *  embedded newlines inside quoted fields, \r\n line endings, and a
 *  leading UTF-8 BOM. Throws on empty input. */
export function parseCsv(input: string): ParsedCsv {
  if (input.length === 0) throw new Error("parseCsv: empty input");
  // Strip BOM.
  if (input.charCodeAt(0) === 0xfeff) input = input.slice(1);

  const records: string[][] = [];
  let field = "";
  let row: string[] = [];
  let i = 0;
  let inQuotes = false;

  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => {
    // Strip trailing \r from the last field if present (CRLF artifact).
    if (row.length > 0) {
      const last = row[row.length - 1] ?? "";
      if (last.endsWith("\r")) row[row.length - 1] = last.slice(0, -1);
    }
    records.push(row);
    row = [];
  };

  while (i < input.length) {
    const ch = input[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += ch;
        i += 1;
      }
    } else {
      if (ch === '"' && field === "") {
        inQuotes = true;
        i += 1;
      } else if (ch === ",") {
        pushField();
        i += 1;
      } else if (ch === "\n") {
        pushField();
        pushRow();
        i += 1;
      } else {
        field += ch;
        i += 1;
      }
    }
  }
  // Flush the last field/row if input didn't end with a newline.
  if (field.length > 0 || row.length > 0) {
    pushField();
    pushRow();
  }

  // Drop a trailing empty record produced by a trailing newline.
  if (records.length > 0) {
    const last = records[records.length - 1];
    if (last && last.length === 1 && last[0] === "") records.pop();
  }

  if (records.length === 0) throw new Error("parseCsv: no rows");
  const [headerRow, ...dataRows] = records;
  if (!headerRow) throw new Error("parseCsv: missing header");
  return {
    header: headerRow,
    rows: dataRows.map((fields, idx) => ({ lineNumber: idx + 1, fields })),
  };
}

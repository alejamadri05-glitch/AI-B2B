// Reads an Outscraper Google Maps export (.xlsx, .csv or the API's .json) and
// returns one plain object per business, keyed by Outscraper's column names.
import fs from "node:fs";
import path from "node:path";
import readXlsxFile from "read-excel-file/node";

export async function loadOutscraperFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".xlsx") {
    const sheets = await readXlsxFile(file);
    return rowsToObjects(sheets[0].data);
  }
  if (ext === ".csv") return rowsToObjects(parseCsv(fs.readFileSync(file, "utf8")));
  if (ext === ".json") {
    // API responses look like { data: [[place, ...], ...] } (one array per query).
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    const data = Array.isArray(json) ? json : json.data;
    return data.flat();
  }
  throw new Error(`Unsupported file type: ${ext} (use .xlsx, .csv or .json)`);
}

function rowsToObjects([header, ...rows]) {
  return rows.map((row) => Object.fromEntries(header.map((key, i) => [key, row[i] ?? null])));
}

// Minimal RFC 4180 parser: quoted fields, escaped quotes, newlines inside quotes.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.map((r) => r.map((v) => (v === "" ? null : v)));
}

export function toCsv(rows, columns) {
  const escape = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [columns.join(","), ...rows.map((r) => columns.map((c) => escape(r[c])).join(","))].join("\n") + "\n";
}

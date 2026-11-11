/**
 * RFC 4180 CSV, built on the server so a browser never has to assemble the file.
 *
 * A request message routinely holds a comma, a quote or a newline, so quoting is
 * the normal case here rather than an edge case: an unquoted message turns one
 * row into two and shifts every later column by one.
 */

/** One field: quoted when it holds a comma, a quote or a line break. */
export function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One record. `\r\n` is what RFC 4180 asks for and what Excel expects. */
export function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(",");
}

/**
 * A byte-order mark in front: Excel reads a bare UTF-8 file as latin-1 and
 * mangles any accent, and this file can hold agent names and messages in any
 * language.
 */
export const CSV_BOM = "\ufeff";

/** A whole document, BOM and header row included. No trailing blank record. */
export function csvText(rows: unknown[][]): string {
  return CSV_BOM + rows.map(csvRow).join("\r\n");
}

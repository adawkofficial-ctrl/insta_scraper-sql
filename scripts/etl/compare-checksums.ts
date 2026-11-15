/**
 * Compare phpMyAdmin checksum output (JSON or CSV) with docs/expected-checksums.json.
 */
import fs from "node:fs";
import path from "node:path";

type Row = { table_name: string; row_count: number; id_checksum: string; business_checksum: string };

function parseRows(content: string): Row[] {
  const trimmed = content.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as unknown;
    const list = Array.isArray(parsed) ? parsed : (parsed as { rows?: unknown[]; data?: unknown[] }).rows ?? (parsed as { data?: unknown[] }).data ?? [];
    return (list as Array<Record<string, unknown>>).map((r) => ({
      table_name: String(r.table_name ?? r.TABLE_NAME ?? r["Table"] ?? ""),
      row_count: Number(r.row_count ?? r.ROW_COUNT ?? r["row_count"] ?? 0),
      id_checksum: String(r.id_checksum ?? r.ID_CHECKSUM ?? ""),
      business_checksum: String(r.business_checksum ?? r.BUSINESS_CHECKSUM ?? ""),
    }));
  }
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const delimiter = lines[0].includes("\t") ? "\t" : ",";
  const cells = (line: string) => line.split(delimiter).map((c) => c.trim().replace(/^"|"$/g, ""));
  const header = cells(lines[0]).map((h) => h.toLowerCase());
  const idx = (name: string) => header.findIndex((h) => h === name);
  const tableIdx = idx("table_name") >= 0 ? idx("table_name") : idx("table");
  const countIdx = idx("row_count");
  const idIdx = idx("id_checksum");
  const bizIdx = idx("business_checksum");
  return lines.slice(1).map((line) => {
    const c = cells(line);
    return {
      table_name: String(c[tableIdx] ?? ""),
      row_count: Number(c[countIdx] ?? 0),
      id_checksum: String(c[idIdx] ?? ""),
      business_checksum: String(c[bizIdx] ?? ""),
    };
  });
}

function main() {
  const inputPath = process.argv[2];
  const file = inputPath && !inputPath.startsWith("--") ? inputPath : "docs/phpmyadmin-checksums.json";
  const actual = parseRows(fs.readFileSync(path.resolve(file), "utf8"));
  const actualByTable = new Map(actual.map((r) => [r.table_name, r]));
  const expected = JSON.parse(fs.readFileSync(path.resolve("docs/expected-checksums.json"), "utf8")) as {
    tables: Record<string, { row_count: number; id_checksum: string; business_checksum: string }>;
    invariants: Record<string, number>;
  };
  let failed = 0;
  for (const [table, exp] of Object.entries(expected.tables)) {
    const act = actualByTable.get(table);
    const pass = Boolean(act) && act!.row_count === exp.row_count && act!.id_checksum === exp.id_checksum && act!.business_checksum === exp.business_checksum;
    if (!pass) failed++;
    console.log(`${pass ? "PASS" : "FAIL"} ${table} :: expected=${exp.row_count}/${exp.id_checksum}/${exp.business_checksum} actual=${act?.row_count ?? "missing"}/${act?.id_checksum ?? "-"}/${act?.business_checksum ?? "-"}`);
  }
  for (const [name, value] of Object.entries(expected.invariants)) {
    const act = actualByTable.get(`INV:${name}`);
    const pass = Boolean(act) && act!.row_count === value;
    if (!pass) failed++;
    console.log(`${pass ? "PASS" : "FAIL"} INV:${name} :: expected=${value} actual=${act?.row_count ?? "missing"}`);
  }
  console.log(`SUMMARY: ${Object.keys(expected.tables).length + Object.keys(expected.invariants).length - failed} PASS / ${failed} FAIL`);
  if (failed > 0) process.exit(1);
}

main();

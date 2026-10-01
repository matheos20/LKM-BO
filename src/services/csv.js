/**
 * Lecture de CSV.
 *
 * Volontairement minuscule, et sans dépendance : l'export Cloudflare du parc fait cinq
 * mégaoctets et quarante mille lignes, mais sa forme est simple. Ce qu'il faut tenir,
 * c'est le cas des guillemets — une valeur peut en contenir, et une virgule à
 * l'intérieur ne sépare rien.
 */

/** Découpe une ligne en champs, en respectant les guillemets doubles. */
export function splitCsvLine(line) {
  const out = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"') {
      // Deux guillemets de suite, à l'intérieur d'une valeur, valent un guillemet.
      if (quoted && line[i + 1] === '"') { current += '"'; i += 1; } else quoted = !quoted;
      continue;
    }
    if (c === ',' && !quoted) { out.push(current); current = ''; continue; }
    current += c;
  }
  out.push(current);
  return out.map((v) => v.trim());
}

/**
 * Les lignes d'un CSV, sous forme d'objets indexés par l'en-tête.
 *
 * Une ligne dont le nombre de champs ne correspond pas à l'en-tête n'est pas devinée :
 * elle est rendue à part, avec son numéro, pour que l'appelant puisse la montrer.
 *
 * @returns {{ columns: string[], rows: object[], malformed: {line:number, raw:string}[] }}
 */
export function parseCsv(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  let first = 0;
  while (first < lines.length && !lines[first].trim()) first += 1;
  if (first >= lines.length) return { columns: [], rows: [], malformed: [] };

  const columns = splitCsvLine(lines[first]).map((c) => c.replace(/^﻿/, '').trim());
  const rows = [];
  const malformed = [];

  for (let i = first + 1; i < lines.length; i += 1) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    const cells = splitCsvLine(raw);
    if (cells.length !== columns.length) {
      malformed.push({ line: i + 1, raw: raw.slice(0, 200) });
      continue;
    }
    const row = {};
    columns.forEach((name, k) => { row[name] = cells[k]; });
    row.__line = i + 1;
    rows.push(row);
  }
  return { columns, rows, malformed };
}

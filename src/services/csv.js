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
/**
 * Découpe un CSV en ENREGISTREMENTS, et non en lignes.
 *
 * CE N'EST PAS LA MÊME CHOSE, et le dossier `thematiques/` l'a prouvé : son fichier
 * anglais commence par
 *
 *     "ANIMALS
 *     ",NEWS
 *
 * — un champ entre guillemets qui contient un retour à la ligne. Découper sur les
 * retours à la ligne coupait cet enregistrement en deux moitiés, toutes deux déclarées
 * mal formées, et la première thématique du fichier disparaissait sans un mot.
 *
 * Chaque enregistrement est rendu avec le NUMÉRO DE SA PREMIÈRE LIGNE physique, pour
 * qu'un signalement renvoie l'agent à l'endroit qu'il voit dans son tableur.
 */
export function splitCsvRecords(text) {
  const src = String(text ?? '');
  const out = [];
  let courant = '';
  let ligne = 1;
  let debut = 1;
  let quoted = false;

  const pousser = () => {
    out.push({ line: debut, raw: courant });
    courant = '';
  };

  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (c === '"') {
      // Deux guillemets de suite, à l'intérieur d'une valeur, valent un guillemet : ils
      // ne changent donc pas l'état.
      if (quoted && src[i + 1] === '"') { courant += '""'; i += 1; continue; }
      quoted = !quoted;
      courant += c;
      continue;
    }
    if ((c === '\n' || c === '\r') && !quoted) {
      // « \r\n » ne compte que pour une fin d'enregistrement.
      if (c === '\r' && src[i + 1] === '\n') i += 1;
      pousser();
      ligne += 1;
      debut = ligne;
      continue;
    }
    if (c === '\n') ligne += 1;
    courant += c;
  }
  if (courant !== '') pousser();
  return out;
}

export function parseCsv(text) {
  const records = splitCsvRecords(text);
  // Le reste du code raisonne sur des lignes depuis toujours ; les enregistrements en
  // tiennent lieu, et chacun garde le numéro de sa première ligne.
  const lines = records.map((r) => r.raw);
  const numeros = records.map((r) => r.line);
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
      malformed.push({ line: numeros[i] ?? i + 1, raw: raw.slice(0, 200) });
      continue;
    }
    const row = {};
    columns.forEach((name, k) => { row[name] = cells[k]; });
    row.__line = numeros[i] ?? i + 1;
    rows.push(row);
  }
  return { columns, rows, malformed };
}

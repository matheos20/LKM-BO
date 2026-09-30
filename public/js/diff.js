/**
 * Comparaison de deux textes, pour que l'agent VOIE ce qui a changé.
 *
 * Le comparatif montrait deux colonnes brutes : retrouver le mot modifié au milieu de
 * quatre kilo-octets de PHP demandait de lire les deux côtés en parallèle, à l'œil.
 * Ici on calcule la différence, et l'écran la montre.
 *
 * Aucune dépendance, aucun accès au document : ce module se teste tel quel.
 */

/**
 * Plus longue sous-suite commune, en table. Les textes comparés font quelques
 * centaines de lignes — une table complète coûte moins cher à lire qu'un algorithme
 * astucieux, et se vérifie à l'œil.
 */
function lcs(a, b, egal = (x, y) => x === y) {
  const n = a.length;
  const m = b.length;
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = egal(a[i], b[j]) ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  // On remonte la table pour produire la suite d'opérations.
  const suite = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (egal(a[i], b[j])) { suite.push({ type: 'same', a: a[i], b: b[j], ia: i, ib: j }); i += 1; j += 1; }
    else if (table[i + 1][j] >= table[i][j + 1]) { suite.push({ type: 'del', a: a[i], ia: i }); i += 1; }
    else { suite.push({ type: 'add', b: b[j], ib: j }); j += 1; }
  }
  while (i < n) { suite.push({ type: 'del', a: a[i], ia: i }); i += 1; }
  while (j < m) { suite.push({ type: 'add', b: b[j], ib: j }); j += 1; }
  return suite;
}

/**
 * Une suppression immédiatement suivie d'un ajout est presque toujours une ligne
 * RETOUCHÉE, pas une ligne jetée puis une autre écrite. Les apparier permet de montrer
 * le mot qui change au lieu de deux lignes entières en rouge et en vert.
 */
function apparier(suite) {
  const sortie = [];
  for (let k = 0; k < suite.length; k += 1) {
    const dels = [];
    while (suite[k]?.type === 'del') dels.push(suite[k++]);
    const adds = [];
    while (suite[k]?.type === 'add') adds.push(suite[k++]);

    const paires = Math.min(dels.length, adds.length);
    for (let p = 0; p < paires; p += 1) sortie.push({ type: 'chg', a: dels[p].a, b: adds[p].b, ia: dels[p].ia, ib: adds[p].ib });
    for (let p = paires; p < dels.length; p += 1) sortie.push(dels[p]);
    for (let p = paires; p < adds.length; p += 1) sortie.push(adds[p]);
    if (suite[k]) sortie.push(suite[k]);
  }
  return sortie;
}

/** Les deux textes, ligne à ligne : identique, retirée, ajoutée ou retouchée. */
export function diffLines(avant, apres) {
  return apparier(lcs(String(avant ?? '').split('\n'), String(apres ?? '').split('\n')));
}

/** Découpe en mots et en séparateurs, pour comparer l'intérieur d'une ligne retouchée. */
const jetons = (s) => String(s ?? '').match(/[\wÀ-ɏ]+|\s+|[^\s\wÀ-ɏ]/g) ?? [];

/**
 * L'intérieur d'une ligne retouchée, morceau par morceau. Sert à surligner le seul mot
 * qui change — « rencontrent » devenu « rencontrentssss » — au lieu de toute la ligne.
 */
export function diffWords(avant, apres) {
  const brut = lcs(jetons(avant), jetons(apres));
  // On recolle les morceaux voisins de même nature : trois jetons ajoutés à la suite
  // font une seule marque, pas trois.
  const parts = [];
  for (const op of brut) {
    const texte = op.type === 'add' ? op.b : op.a;
    const dernier = parts[parts.length - 1];
    if (dernier && dernier.type === op.type) dernier.text += texte;
    else parts.push({ type: op.type, text: texte });
  }
  return parts;
}

/** Ce qu'on annonce en tête : combien de lignes ajoutées, retirées, retouchées. */
export function summarize(lignes) {
  const compte = { added: 0, removed: 0, changed: 0 };
  for (const l of lignes) {
    if (l.type === 'add') compte.added += 1;
    else if (l.type === 'del') compte.removed += 1;
    else if (l.type === 'chg') compte.changed += 1;
  }
  compte.total = compte.added + compte.removed + compte.changed;
  return compte;
}

/**
 * Regroupe les lignes en tranches, en repliant les longues plages identiques. Sur un
 * fichier de configuration, l'agent cherche LE passage modifié : lui présenter cent
 * lignes inchangées autour revient à le lui cacher.
 *
 * @returns {{kind:'hunk'|'fold', lines?:Array, count?:number}[]}
 */
export function groupHunks(lignes, contexte = 3) {
  // Les lignes qu'on garde : celles qui changent, plus leur voisinage.
  const garder = new Set();
  lignes.forEach((l, i) => {
    if (l.type === 'same') return;
    for (let k = Math.max(0, i - contexte); k <= Math.min(lignes.length - 1, i + contexte); k += 1) garder.add(k);
  });
  if (!garder.size) return [{ kind: 'fold', count: lignes.length }];

  const blocs = [];
  let i = 0;
  while (i < lignes.length) {
    if (garder.has(i)) {
      const debut = i;
      while (i < lignes.length && garder.has(i)) i += 1;
      blocs.push({ kind: 'hunk', lines: lignes.slice(debut, i), start: debut });
    } else {
      const debut = i;
      while (i < lignes.length && !garder.has(i)) i += 1;
      blocs.push({ kind: 'fold', count: i - debut, start: debut });
    }
  }
  return blocs;
}

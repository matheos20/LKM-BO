/**
 * Contrôle statique : toute fonction APPELÉE doit être déclarée dans le fichier ou
 * importée.
 *
 * Pourquoi ce fichier existe. Les modules de `public/js/` tournent dans le navigateur et
 * ne sont chargés par aucun test : une fonction oubliée à l'import ne se voyait qu'à
 * l'usage, et seulement sur le chemin qui l'appelle. C'est arrivé avec `fmtSize` dans
 * l'onglet Sauvegardes — le rendu jetait dès qu'un site avait une sauvegarde, l'écran
 * restait figé sur « Lecture des sauvegardes… » et le bouton Actualiser restait grisé.
 * Un site sans sauvegarde, lui, s'affichait très bien. Ce contrôle voit ce cas sans rien
 * exécuter.
 *
 * Ce n'est pas un analyseur complet : il ne suit pas les portées. Il répond à une seule
 * question, celle qui nous a coûté cher, et il y répond sans faux positif sur ce dépôt.
 */

/** Ce qui existe sans être déclaré nulle part : globales du navigateur et mots-clés. */
const GLOBALS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'await', 'new', 'do', 'else', 'yield', 'void', 'delete', 'in', 'of', 'case', 'throw', 'super', 'this', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'Date', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'RegExp', 'Error', 'TypeError', 'RangeError', 'URL', 'URLSearchParams', 'FormData', 'Blob', 'File', 'FileReader', 'Image', 'Node', 'Intl', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'queueMicrotask', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'btoa', 'atob', 'structuredClone', 'alert', 'confirm', 'prompt', 'console', 'document', 'window', 'navigator', 'localStorage', 'sessionStorage', 'history', 'location', 'CustomEvent', 'Event', 'AbortController', 'AbortSignal', 'DOMParser', 'XMLHttpRequest', 'TextEncoder', 'TextDecoder', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'DataView', 'ArrayBuffer', 'Symbol', 'BigInt', 'Infinity', 'NaN', 'undefined', 'null', 'true', 'false', 'class', 'const', 'let', 'var', 'import', 'export', 'default', 'try', 'finally', 'break', 'continue', 'instanceof', 'MutationObserver', 'IntersectionObserver', 'ResizeObserver', 'getComputedStyle', 'crypto', 'Text', 'async', 'get', 'set', 'static', 'globalThis']);

/**
 * Remplace le contenu des chaînes, gabarits, commentaires et littéraux d'expression
 * régulière par des espaces, en gardant longueur et retours à la ligne — les numéros de
 * ligne restent donc justes. Sans cela, un mot dans un libellé passerait pour un appel.
 *
 * Une première version faisait ce travail à coups d'expressions régulières. Sur un
 * fichier à gabarits imbriqués, l'appariement des accents graves déraillait et avalait
 * 90 % du code : tout passait alors pour propre. D'où ce balayage caractère par
 * caractère, et le garde-fou de `checkFile`.
 */
export function scanSource(source) {
  // « split('') » et non « Array.from » : celui-ci découpe par POINTS DE CODE, alors que
  // les indices ci-dessous parcourent la chaîne en unités UTF-16. Un seul emoji dans le
  // fichier — il y en a un — décalait d'un cran tout ce qui suit, et le nettoyage rognait
  // alors des caractères de code, inventant des appels qui n'existaient pas.
  const out = source.split('');
  const blank = (i) => { if (out[i] !== undefined && out[i] !== '\n') out[i] = ' '; };

  // Une barre oblique ouvre une expression régulière ou une division selon ce qui
  // précède : après une valeur, c'est une division.
  const afterValue = (i) => {
    let j = i - 1;
    while (j >= 0 && /\s/.test(source[j])) j -= 1;
    return j >= 0 && /[\w$)\]]/.test(source[j]);
  };

  // Ce qui est entre en cours de route et n'a jamais ete referme. C'est LE symptome
  // d'un balayage qui a perdu le fil : compter les accolades ne suffit pas, car avaler
  // tout le reste du fichier les laisse trivialement equilibrees a zero.
  let ouvert = null;

  // Profondeur d'accolades de chaque « ${ … } » ouvert : on y revient à sa fermeture.
  const templates = [];
  // Avance dans un gabarit jusqu'à sa fin, ou jusqu'au prochain « ${ » qui rend la
  // main au code.
  const runTemplate = (start) => {
    let i = start;
    while (i < source.length) {
      if (source[i] === '\\') { blank(i); blank(i + 1); i += 2; continue; }
      if (source[i] === '`') { blank(i); return i + 1; }
      if (source[i] === '$' && source[i + 1] === '{') { blank(i); blank(i + 1); templates.push(0); return i + 2; }
      blank(i);
      i += 1;
    }
    ouvert = 'gabarit';
    return i;
  };

  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') { while (i < source.length && source[i] !== '\n') blank(i++); continue; }
    if (c === '/' && source[i + 1] === '*') {
      blank(i++); blank(i++);
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) blank(i++);
      if (i >= source.length) ouvert = 'commentaire de bloc';
      blank(i++); blank(i++);
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      blank(i++);
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') blank(i++);
        if (i < source.length) blank(i++);
      }
      if (i >= source.length) ouvert = 'chaîne';
      blank(i++);
      continue;
    }
    if (c === '`') { blank(i); i = runTemplate(i + 1); continue; }
    if (templates.length && c === '{') { templates[templates.length - 1] += 1; i += 1; continue; }
    if (templates.length && c === '}') {
      if (templates[templates.length - 1] === 0) { templates.pop(); blank(i); i = runTemplate(i + 1); continue; }
      templates[templates.length - 1] -= 1;
      i += 1;
      continue;
    }
    if (c === '/' && !afterValue(i)) {
      blank(i++);
      let inClass = false;
      while (i < source.length && (inClass || source[i] !== '/')) {
        if (source[i] === '\n') break;
        if (source[i] === '\\') blank(i++);
        else if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
        blank(i++);
      }
      blank(i++);
      while (i < source.length && /[a-z]/.test(source[i])) blank(i++);
      continue;
    }
    i += 1;
  }
  if (templates.length) ouvert = 'expression de gabarit';
  return { code: out.join(''), ouvert };
}

/** Le code seul, chaines neutralisees. Raccourci de `scanSource`. */
export const stripLiterals = (source) => scanSource(source).code;

/** Tous les noms qu'un fichier peut appeler : importés, déclarés, reçus en paramètre. */
function knownNames(source, code) {
  const known = new Set(GLOBALS);
  for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(/\s+as\s+/).pop().trim();
      if (name) known.add(name);
    }
  }
  for (const m of source.matchAll(/import\s+(\w+)\s*(?:,|from)/g)) known.add(m[1]);
  for (const m of code.matchAll(/\b(?:function\s*\*?|class)\s+([\w$]+)/g)) known.add(m[1]);
  // « [\w$] » et non « \w » : sinon « const $ = … » se ferait prendre pour un appel.
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([\w$]+)/g)) known.add(m[1]);
  for (const m of code.matchAll(/\b(?:const|let|var)\s*[[{]([^\]}]*)[\]}]/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(/[:=]/).pop().trim().replace(/^\.\.\./, '');
      if (/^[\w$]+$/.test(name)) known.add(name);
    }
  }
  // Les paramètres, y compris déstructurés d'un objet d'options : « { onClear } ».
  for (const m of code.matchAll(/[({,]\s*(?:\.\.\.)?([\w$]+)\s*(?=[,)}=])/g)) known.add(m[1]);
  // Les méthodes abrégées et les accesseurs : « stats() { … } », « get cle() { … } »
  // sont des DÉCLARATIONS, pas des appels.
  //
  // UN NIVEAU DE PARENTHÈSES EST ADMIS DANS LES PARAMÈTRES, parce qu'une valeur par
  // défaut peut en contenir : « constructor(ssh, load = new ServerLoad(ssh)) ». Avec
  // « [^()]* », cette déclaration n'était pas reconnue, et le nom passait ensuite pour un
  // appel non déclaré — premier faux positif de ce contrôle, le 05/10/2026.
  for (const m of code.matchAll(/(?:^|[,{;])\s*(?:(?:async|get|set|static)\s+)*\*?\s*([\w$]+)\s*\((?:[^()]|\([^()]*\))*\)\s*\{/gm)) known.add(m[1]);
  for (const m of code.matchAll(/\b([\w$]+)\s*:/g)) known.add(m[1]);
  for (const m of code.matchAll(/catch\s*\(\s*([\w$]+)/g)) known.add(m[1]);
  return known;
}

/**
 * Les fonctions appelées dans le vide d'un fichier, avec leur première ligne.
 * Lève si le nettoyage a visiblement déraillé : mieux vaut un contrôle qui s'arrête
 * qu'un contrôle qui se tait à tort.
 */
export function checkFile(source) {
  const { code, ouvert } = scanSource(source);

  // GARDE-FOU : le balayage a-t-il gardé le fil ?
  //
  // Un premier jet comparait la quantité de code restante à l'originale et refusait de
  // conclure en dessous de 30 %. Mauvais critère : `phpScripts.js` et `siteDriver.js`
  // sont faits presque entièrement de chaînes — des scripts PHP et des commandes shell —
  // et tombent légitimement à 1 % et 21 %. Ils échappaient donc au contrôle.
  //
  // Deux signes valent mieux. Un littéral jamais refermé dit que le balayage s'est perdu
  // et a tout avalé jusqu'au bout — et cet avalement-là laisse justement les accolades
  // équilibrées à zéro, donc le second signe ne suffirait pas. Un déséquilibre, lui,
  // trahit un avalement partiel : un fichier qui compile a ses paires complètes.
  if (ouvert) throw new Error(`nettoyage des chaînes déraillé : ${ouvert} jamais refermé`);
  for (const [ouvre, ferme, nom] of [['{', '}', 'accolades'], ['(', ')', 'parenthèses'], ['[', ']', 'crochets']]) {
    const a = code.split(ouvre).length - 1;
    const b = code.split(ferme).length - 1;
    if (a !== b) throw new Error(`nettoyage des chaînes déraillé : ${a} ${ouvre} pour ${b} ${ferme} (${nom})`);
  }

  // LES ESPACES SONT COMPACTÉS AVANT L'ANALYSE, les retours à la ligne conservés.
  // Neutraliser une chaîne laisse sa place en blancs : `phpScripts.js`, qui est fait de
  // scripts PHP, devenait 69 Ko d'espaces. Les motifs ci-dessous enchaînent des « \s* »,
  // et sur de telles étendues leur retour arrière explose — ce seul fichier coûtait
  // cent douze secondes. Compacté, l'ensemble du dépôt tient en moins d'une seconde, et
  // aucun nom détecté ne change.
  const dense = code.replace(/[^\S\n]+/g, ' ');

  const known = knownNames(source, dense);
  const counts = new Map();
  // « [^.\w$#] » : le dièse exclut les méthodes privées d'une classe. « this.#run() »
  // se lit déjà par le point, mais « #run() » dans sa propre déclaration, non — et le
  // contrôle criait alors au nom inconnu sur du code parfaitement sain.
  for (const m of dense.matchAll(/(^|[^.\w$#])([a-zA-Z_$][\w$]*)\s*\(/g)) {
    const name = m[2];
    if (!known.has(name)) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const lines = source.split('\n');
  return [...counts].map(([name, count]) => ({
    name,
    count,
    line: lines.findIndex((l) => new RegExp(`(^|[^.\\w$])${name}\\s*\\(`).test(l)) + 1,
  }));
}

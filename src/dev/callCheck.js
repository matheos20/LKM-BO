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
const GLOBALS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'await', 'new', 'do', 'else', 'yield', 'void', 'delete', 'in', 'of', 'case', 'throw', 'super', 'this', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'Date', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'RegExp', 'Error', 'TypeError', 'RangeError', 'URL', 'URLSearchParams', 'FormData', 'Blob', 'File', 'FileReader', 'Image', 'Node', 'Intl', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'queueMicrotask', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'btoa', 'atob', 'structuredClone', 'alert', 'confirm', 'prompt', 'console', 'document', 'window', 'navigator', 'localStorage', 'sessionStorage', 'history', 'location', 'CustomEvent', 'Event', 'AbortController', 'AbortSignal', 'DOMParser', 'XMLHttpRequest', 'TextEncoder', 'TextDecoder', 'Uint8Array', 'ArrayBuffer', 'Symbol', 'BigInt', 'Infinity', 'NaN', 'undefined', 'null', 'true', 'false', 'class', 'const', 'let', 'var', 'import', 'export', 'default', 'try', 'finally', 'break', 'continue', 'instanceof', 'MutationObserver', 'IntersectionObserver', 'ResizeObserver', 'getComputedStyle', 'crypto', 'Text', 'async', 'get', 'set', 'static', 'globalThis']);

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
export function stripLiterals(source) {
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
    return i;
  };

  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') { while (i < source.length && source[i] !== '\n') blank(i++); continue; }
    if (c === '/' && source[i + 1] === '*') {
      blank(i++); blank(i++);
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) blank(i++);
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
  return out.join('');
}

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
  for (const m of code.matchAll(/(?:^|[,{;])\s*(?:(?:async|get|set|static)\s+)*\*?\s*([\w$]+)\s*\([^()]*\)\s*\{/gm)) known.add(m[1]);
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
  const code = stripLiterals(source);
  const kept = code.replace(/\s/g, '').length / Math.max(1, source.replace(/\s/g, '').length);
  if (kept < 0.3) throw new Error(`nettoyage des chaînes déraillé : ${Math.round(kept * 100)} % du code restant`);

  const known = knownNames(source, code);
  const counts = new Map();
  for (const m of code.matchAll(/(^|[^.\w$])([a-zA-Z_$][\w$]*)\s*\(/g)) {
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

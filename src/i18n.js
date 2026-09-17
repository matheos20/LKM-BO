import fs from 'node:fs';
import path from 'node:path';
import { ROOT, config } from './config.js';

/**
 * i18n dynamique : chaque fichier locales/<code>.json est une langue.
 * Ajouter une langue = déposer un fichier JSON (rechargé à chaud, sans redémarrage).
 */
const DIR = path.join(ROOT, 'locales');
const CODE_RE = /^[a-z]{2}(-[A-Z]{2})?$/;
let catalogs = new Map();

export function loadLocales() {
  const next = new Map();
  for (const f of fs.readdirSync(DIR)) {
    const code = f.replace(/\.json$/, '');
    if (!f.endsWith('.json') || !CODE_RE.test(code)) continue;
    try {
      next.set(code, JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')));
    } catch (err) {
      console.error(`[i18n] ${f} ignoré : ${err.message}`);
    }
  }
  if (!next.has(config.defaultLang)) throw new Error(`[i18n] langue par défaut absente : locales/${config.defaultLang}.json`);
  catalogs = next;
  return catalogs;
}

export function watchLocales() {
  let timer;
  fs.watch(DIR, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        loadLocales();
        console.log(`[i18n] rechargé : ${[...catalogs.keys()].join(', ')}`);
      } catch (err) {
        console.error(err.message);
      }
    }, 200);
  }).unref();
}

export const hasLang = (code) => catalogs.has(code);
export const catalog = (code) => catalogs.get(code) ?? catalogs.get(config.defaultLang);
export const languages = () =>
  [...catalogs].map(([code, c]) => ({ code, name: c._meta?.name ?? code })).sort((a, b) => a.name.localeCompare(b.name));

const lookup = (obj, key) => key.split('.').reduce((o, k) => o?.[k], obj);

/**
 * Traduit une clé ; repli : langue par défaut, puis anglais, puis la clé elle-même.
 * Une variable de la forme "@clé.i18n" est elle-même traduite (ex. { reason: '@reason.sudo_denied' }).
 */
export function translate(lang, key, vars = {}) {
  const s = lookup(catalog(lang), key) ?? lookup(catalog(config.defaultLang), key) ?? lookup(catalogs.get('en'), key);
  if (typeof s !== 'string') return key;
  return s.replace(/\{(\w+)\}/g, (m, k) => {
    if (!(k in vars)) return m;
    const v = vars[k];
    return typeof v === 'string' && v.startsWith('@') ? translate(lang, v.slice(1)) : String(v);
  });
}

/** Ordre : ?lang=  →  en-tête X-Lang  →  Accept-Language  →  DEFAULT_LANG. */
export function detectLang(req) {
  for (const c of [req.query?.lang, req.get('x-lang')]) if (typeof c === 'string' && hasLang(c)) return c;
  for (const part of (req.get('accept-language') || '').split(',')) {
    const c = part.split(';')[0].trim().slice(0, 2).toLowerCase();
    if (hasLang(c)) return c;
  }
  return config.defaultLang;
}

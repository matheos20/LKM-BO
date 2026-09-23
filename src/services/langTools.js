/**
 * Outils de langue du parc : langues reconnues, dictionnaire des expressions courantes
 * et traduction automatique facultative.
 *
 * Le repérage des textes dans la mauvaise langue, lui, est fait par PHP sur le serveur
 * du site (voir SCAN_LANG) : `config.php` EST du PHP, et l'interpréteur du site reste
 * le seul à le lire exactement.
 */

/** Langues du parc. `UK` est le code employé par le moteur pour l'anglais. */
export const LANGS = ['FR', 'UK', 'ES', 'PT', 'DE', 'IT', 'NL'];

/** Codes rencontrés dans `$site_lang`, ramenés aux langues du parc. */
export const LANG_ALIASES = { EN: 'UK', GB: 'UK', US: 'UK', BR: 'PT', MX: 'ES', AT: 'DE', BE: 'NL' };

export const normalizeLang = (code) => {
  const up = String(code ?? '').trim().toUpperCase();
  const mapped = LANG_ALIASES[up] ?? up;
  return LANGS.includes(mapped) ? mapped : null;
};

/**
 * Expressions qui reviennent sur tout le parc, dans les sept langues.
 * Elles évitent un appel réseau — et surtout une approximation — sur les libellés
 * d'interface, là où une traduction machine hésite (« Découvrir », « Commencer »…).
 * Ordre des colonnes : FR, UK, ES, PT, DE, IT, NL.
 */
const DICTIONARY = [
  ['Nos articles', 'Our articles', 'Nuestros artículos', 'Os nossos artigos', 'Unsere Artikel', 'I nostri articoli', 'Onze artikelen'],
  ['Voir les articles', 'View articles', 'Ver los artículos', 'Ver os artigos', 'Artikel ansehen', 'Vedi gli articoli', 'Bekijk artikelen'],
  ['Voir tous les articles', 'View all articles', 'Ver todos los artículos', 'Ver todos os artigos', 'Alle Artikel ansehen', 'Vedi tutti gli articoli', 'Bekijk alle artikelen'],
  ['Derniers articles', 'Latest articles', 'Últimos artículos', 'Últimos artigos', 'Neueste Artikel', 'Ultimi articoli', 'Laatste artikelen'],
  ['Questions fréquentes', 'Frequently asked questions', 'Preguntas frecuentes', 'Perguntas frequentes', 'Häufige Fragen', 'Domande frequenti', 'Veelgestelde vragen'],
  ['Quelques chiffres', 'Some numbers', 'Algunas cifras', 'Alguns números', 'Einige Zahlen', 'Alcuni numeri', 'Enkele cijfers'],
  ['Nos rubriques', 'Our sections', 'Nuestras secciones', 'As nossas secções', 'Unsere Rubriken', 'Le nostre rubriche', 'Onze rubrieken'],
  ['Découvrir', 'Discover', 'Descubrir', 'Descobrir', 'Entdecken', 'Scopri', 'Ontdekken'],
  ['En savoir plus', 'Learn more', 'Más información', 'Saber mais', 'Mehr erfahren', 'Scopri di più', 'Meer informatie'],
  ['Lire la suite', 'Read more', 'Leer más', 'Ler mais', 'Weiterlesen', 'Continua a leggere', 'Lees verder'],
  ['Nous contacter', 'Contact us', 'Contáctanos', 'Contacte-nos', 'Kontaktieren Sie uns', 'Contattaci', 'Neem contact op'],
  ["S'abonner", 'Subscribe', 'Suscribirse', 'Subscrever', 'Abonnieren', 'Iscriviti', 'Abonneren'],
  ['Votre adresse email', 'Your email address', 'Tu correo electrónico', 'O seu endereço de email', 'Ihre E-Mail-Adresse', 'Il tuo indirizzo email', 'Uw e-mailadres'],
  ['Commencer', 'Get started', 'Comenzar', 'Começar', 'Loslegen', 'Inizia', 'Beginnen'],
];

/** Clé de comparaison : la casse, les accents et la ponctuation finale ne doivent pas séparer deux variantes. */
const key = (text) =>
  String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[\s ]+/g, ' ')
    .replace(/^[\s!?.:;,–—-]+|[\s!?.:;,–—-]+$/g, '')
    .trim();

const INDEX = new Map();
for (const row of DICTIONARY) {
  const entry = Object.fromEntries(LANGS.map((lg, i) => [lg, row[i]]));
  for (const value of row) if (value) INDEX.set(key(value), entry);
}

/**
 * Traduction connue d'une expression courante, ou `null`.
 * La casse d'origine du premier caractère est conservée : un titre reste un titre.
 */
export function dictionaryLookup(text, target) {
  const lang = normalizeLang(target);
  if (!lang) return null;
  const entry = INDEX.get(key(text));
  const found = entry?.[lang];
  if (!found || found === text) return null;
  const source = String(text);
  if (source === source.toUpperCase() && source !== source.toLowerCase()) return found.toUpperCase();
  return found;
}

/** Codes DeepL : la cible accepte une variante régionale, la source non. */
const DEEPL_TARGET = { UK: 'EN-GB', PT: 'PT-PT', FR: 'FR', ES: 'ES', DE: 'DE', IT: 'IT', NL: 'NL' };
const DEEPL_SOURCE = { UK: 'EN', PT: 'PT', FR: 'FR', ES: 'ES', DE: 'DE', IT: 'IT', NL: 'NL' };

/**
 * Traduction automatique par DeepL, si une clé est configurée (`DEEPL_KEY`).
 * Les textes gardent leurs balises (`<strong>`, `<a>`…) : `tag_handling=html`.
 * Sans clé, l'appelant reçoit `null` et l'agent saisit lui-même la traduction.
 */
export async function machineTranslate(texts, { from, to, key: apiKey, endpoint, fetchImpl = fetch } = {}) {
  const list = (Array.isArray(texts) ? texts : []).map((v) => String(v ?? '')).filter(Boolean);
  const target = DEEPL_TARGET[normalizeLang(to)];
  const source = DEEPL_SOURCE[normalizeLang(from)];
  if (!apiKey || !target || !list.length) return null;

  const body = new URLSearchParams();
  body.set('auth_key', apiKey);
  body.set('target_lang', target);
  if (source) body.set('source_lang', source);
  body.set('tag_handling', 'html');
  body.set('preserve_formatting', '1');
  for (const text of list) body.append('text', text);

  const url = endpoint || (apiKey.endsWith(':fx') ? 'https://api-free.deepl.com/v2/translate' : 'https://api.deepl.com/v2/translate');
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(30000),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload?.message || `DeepL ${res.status}`);
  return (payload.translations ?? []).map((tr) => String(tr?.text ?? ''));
}

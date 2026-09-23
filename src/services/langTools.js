import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

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
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
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
  // Même texte, ou même texte à un accent près : il n'y a rien à traduire.
  // (51 sites français du parc écrivent « Questions frequentes » sans accent ;
  //  les proposer ici noierait le vrai travail de traduction.)
  if (!found || found === text || key(found) === key(text)) return null;
  const source = String(text);
  if (source === source.toUpperCase() && source !== source.toLowerCase()) return found.toUpperCase();
  return found;
}


// ───────────────────────── Traduction automatique ─────────────────────────

/**
 * Trois services au choix, aucun obligatoire.
 *
 * Le parc entier représente environ 61 000 caractères à traduire (mesure du
 * 23/09/2026 : 112 textes distincts sur 2 400 sites, extrapolés aux 28 176
 * domaines) — l'offre gratuite de DeepL, 500 000 caractères par mois, couvre
 * huit fois ce besoin. Google convient à qui a déjà un compte Cloud ;
 * LibreTranslate convient à qui ne veut envoyer ses textes à personne.
 *
 * Chaque service reçoit les textes tels quels, balises comprises : un titre
 * peut contenir <strong> ou un lien, et le remplacement doit les conserver.
 */

/** Claude reçoit des noms de langue : plus sûr qu'un code à deux lettres. */
const LANG_NAMES = { FR: 'French', UK: 'British English', ES: 'Spanish', PT: 'European Portuguese', DE: 'German', IT: 'Italian', NL: 'Dutch' };

/** Codes par service. La cible accepte une variante régionale, la source rarement. */
const CODES = {
  deepl: { target: { UK: 'EN-GB', PT: 'PT-PT', FR: 'FR', ES: 'ES', DE: 'DE', IT: 'IT', NL: 'NL' }, source: { UK: 'EN', PT: 'PT', FR: 'FR', ES: 'ES', DE: 'DE', IT: 'IT', NL: 'NL' } },
  google: { target: { UK: 'en', PT: 'pt', FR: 'fr', ES: 'es', DE: 'de', IT: 'it', NL: 'nl' }, source: { UK: 'en', PT: 'pt', FR: 'fr', ES: 'es', DE: 'de', IT: 'it', NL: 'nl' } },
  claude: { target: LANG_NAMES, source: LANG_NAMES },
  libre: { target: { UK: 'en', PT: 'pt', FR: 'fr', ES: 'es', DE: 'de', IT: 'it', NL: 'nl' }, source: { UK: 'en', PT: 'pt', FR: 'fr', ES: 'es', DE: 'de', IT: 'it', NL: 'nl' } },
};

/** Google renvoie du HTML échappé, même pour du texte simple. */
const unescapeHtml = (text) =>
  String(text)
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');

const post = async (fetchImpl, url, init) => {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(30000) });
  const payload = await res.json().catch(() => ({}));
  return { res, payload };
};

const BACKENDS = {
  /** DeepL — la meilleure qualité sur les langues du parc, offre gratuite généreuse. */
  async deepl(texts, { from, to, settings, fetchImpl }) {
    const body = new URLSearchParams();
    body.set('auth_key', settings.key);
    body.set('target_lang', to);
    if (from) body.set('source_lang', from);
    body.set('tag_handling', 'html');
    body.set('preserve_formatting', '1');
    for (const text of texts) body.append('text', text);

    const url = settings.endpoint || (settings.key.endsWith(':fx') ? 'https://api-free.deepl.com/v2/translate' : 'https://api.deepl.com/v2/translate');
    const { res, payload } = await post(fetchImpl, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) throw new Error(payload?.message || `DeepL ${res.status}`);
    return (payload.translations ?? []).map((tr) => String(tr?.text ?? ''));
  },

  /** Google Cloud Translation v2 : une clé d'API suffit, la facturation est au caractère. */
  async google(texts, { from, to, settings, fetchImpl }) {
    const url = `${settings.endpoint || 'https://translation.googleapis.com/language/translate/v2'}?key=${encodeURIComponent(settings.key)}`;
    const { res, payload } = await post(fetchImpl, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: texts, target: to, source: from || undefined, format: 'html' }),
    });
    if (!res.ok) throw new Error(payload?.error?.message || `Google ${res.status}`);
    return (payload.data?.translations ?? []).map((tr) => unescapeHtml(tr?.translatedText ?? ''));
  },

  /**
   * Claude, par le SDK officiel.
   *
   * Les textes du parc sont des slogans et des titres, souvent porteurs de balises
   * (« L'art de la <em>maîtrise</em> quotidienne ») et de tournures publicitaires que
   * les traducteurs automatiques rendent plates. Un modèle de langue garde le ton et
   * les balises, et comprend qu'un titre reste un titre.
   *
   * La réponse est contrainte par un schéma : ni préambule, ni explication, ni numéro
   * — un tableau de chaînes, dans l'ordre reçu. L'effort est réglé bas : traduire une
   * ligne de vingt mots ne demande pas de longue réflexion.
   */
  async claude(texts, { from, to, settings }) {
    const client = settings.client ?? new Anthropic({ apiKey: settings.key });
    const schema = z.object({ translations: z.array(z.string()) });
    const source = from ? `from ${from} ` : '';

    const res = await client.messages.parse({
      model: settings.model,
      max_tokens: 8000,
      system:
        `You translate short website texts ${source}into ${to}. ` +
        'Return one translation per input text, in the same order, same count. ' +
        'Keep every inline HTML tag exactly as it appears (<em>, <strong>, <a href="...">) around the matching words. ' +
        'Keep emoji, quotation marks and trailing arrows. Keep the register of marketing copy: a headline stays a headline, ' +
        'never a literal word-for-word rendering. Translate nothing else, add nothing, explain nothing.',
      output_config: { format: zodOutputFormat(schema), effort: 'low' },
      messages: [{ role: 'user', content: JSON.stringify(texts) }],
    });

    const out = res.parsed_output?.translations;
    if (!Array.isArray(out)) throw new Error('Claude: réponse illisible');
    // Un décalage de longueur rendrait des traductions à côté de leur texte : on refuse.
    if (out.length !== texts.length) throw new Error(`Claude: ${out.length} traduction(s) pour ${texts.length} texte(s)`);
    return out.map((v) => String(v));
  },

  /** LibreTranslate : libre et installable chez soi, quand les textes ne doivent pas sortir. */
  async libre(texts, { from, to, settings, fetchImpl }) {
    const base = String(settings.url).replace(/\/+$/, '');
    const { res, payload } = await post(fetchImpl, `${base}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // LibreTranslate exige une langue source : « auto » la lui fait deviner.
      body: JSON.stringify({ q: texts, source: from || 'auto', target: to, format: 'html', api_key: settings.key || undefined }),
    });
    if (!res.ok) throw new Error(payload?.error || `LibreTranslate ${res.status}`);
    const out = payload.translatedText;
    return Array.isArray(out) ? out.map((v) => String(v)) : [String(out ?? '')];
  },
};

export const PROVIDERS = Object.keys(BACKENDS);

/**
 * Modèle par défaut pour Claude. Traduire la page d'accueil de tout le parc coûte
 * moins d'un dollar ; `ANTHROPIC_MODEL` permet néanmoins de choisir un modèle plus
 * économique (`claude-haiku-4-5`) pour les très gros lots.
 */
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5';

/**
 * Choisit le service configuré. L'ordre traduit la qualité constatée sur les
 * langues du parc ; il suffit d'effacer une clé pour passer au suivant.
 */
export function pickProvider({ deeplKey = '', claudeKey = '', claudeModel = '', googleKey = '', libreUrl = '', libreKey = '', endpoint = '', client = null } = {}) {
  if (deeplKey) return { name: 'deepl', settings: { key: deeplKey, endpoint } };
  if (claudeKey || client) return { name: 'claude', settings: { key: claudeKey, model: claudeModel || DEFAULT_CLAUDE_MODEL, client } };
  if (googleKey) return { name: 'google', settings: { key: googleKey, endpoint } };
  if (libreUrl) return { name: 'libre', settings: { url: libreUrl, key: libreKey } };
  return null;
}

/**
 * Traduit une liste de textes. Rend `null` si aucun service n'est configuré :
 * l'écran reste utilisable, l'agent saisissant lui-même les traductions.
 */
export async function machineTranslate(texts, { from, to, provider, fetchImpl = fetch } = {}) {
  const list = (Array.isArray(texts) ? texts : []).map((v) => String(v ?? '')).filter(Boolean);
  const name = provider?.name;
  const codes = CODES[name];
  const target = codes?.target[normalizeLang(to)];
  const source = codes?.source[normalizeLang(from)];
  if (!name || !target || !list.length) return null;
  return BACKENDS[name](list, { from: source, to: target, settings: provider.settings ?? {}, fetchImpl });
}

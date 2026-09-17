import { sanitizeInline, sanitizePlain, sanitizeUrl } from './htmlText.js';
import { AppError } from '../errors.js';

/**
 * Catalogue des composants du moteur de site et validation des configurations.
 *
 * Les familles et leurs champs sont déduits de la lecture des 53 modèles de
 * `parts/sections/` : chaque famille lit une clé de `$homepage`, et l'éditeur
 * présente exactement les champs que ces modèles savent afficher.
 */

export const SITE_LANGS = ['FR', 'UK', 'ES', 'IT', 'DE', 'NL', 'PT'];

export const PRESETS = {
  header_nav: ['inline', 'below', 'sides', 'pill', 'double_row', 'stacked', 'split', 'hidden'],
  header_logo: ['left', 'center'],
  header_cta: ['none', 'button'],
  footer_style: ['centered', 'centered_slogan', 'columns_2', 'columns_3', 'columns_4', 'dark_gradient', 'inline', 'minimal', 'split_footer', 'wave', 'colorful'],
  category_style: ['classic', 'cards_horizontal', 'cards_gallery', 'list', 'minimal', 'banner', 'magazine'],
  article_style: ['classic', 'immersive', 'editorial', 'sidebar', 'minimal', 'card'],
};

const button = (key) => ({ key, type: 'button' });

/** Familles de sections : clé de données, variantes disponibles, champs éditables. */
export const SECTION_FAMILIES = [
  {
    key: 'hero',
    variants: ['hero_split', 'hero_split_reverse', 'hero_centered', 'hero_full', 'hero_minimal', 'hero_overlay'],
    fields: [
      { key: 'badge', type: 'text' },
      { key: 'title', type: 'rich' },
      { key: 'text', type: 'textarea' },
      { key: 'image', type: 'image' },
      { key: 'image_alt', type: 'text' },
      button('btn_primary'),
      button('btn_secondary'),
    ],
  },
  {
    key: 'categories',
    variants: ['categories_pills', 'categories_grid', 'categories_banner', 'categories_images', 'categories_list', 'categories_minimal', 'categories_split'],
    fields: [
      { key: 'title', type: 'text' },
      { key: 'text', type: 'textarea' },
    ],
  },
  {
    key: 'articles',
    variants: ['articles_list', 'articles_minimal', 'articles_preview', 'articles_featured', 'articles_magazine', 'articles_cards_horizontal'],
    fields: [
      { key: 'title', type: 'text' },
      { key: 'text', type: 'textarea' },
      { key: 'count', type: 'number', min: 1, max: 100 },
    ],
  },
  {
    key: 'split',
    variants: ['split_content', 'split_content_reverse', 'split_content_card', 'split_content_dark', 'split_content_minimal'],
    fields: [
      { key: 'title', type: 'text' },
      { key: 'text', type: 'textarea' },
      { key: 'features', type: 'strings' },
      { key: 'image', type: 'image' },
      { key: 'image_alt', type: 'text' },
      button('btn'),
    ],
  },
  {
    key: 'stats',
    variants: ['stats_bar', 'stats_cards', 'stats_circles', 'stats_columns', 'stats_gradient', 'stats_highlight', 'stats_minimal'],
    fields: [
      { key: 'title', type: 'text' },
      { key: 'text', type: 'textarea' },
      { key: 'items', type: 'list', item: [{ key: 'number', type: 'text' }, { key: 'label', type: 'text' }, { key: 'icon', type: 'text' }] },
    ],
    listRoot: true,
  },
  {
    key: 'testimonials',
    variants: ['testimonials_grid', 'testimonials_highlight', 'testimonials_list', 'testimonials_minimal', 'testimonials_single'],
    fields: [
      { key: 'title', type: 'text' },
      { key: 'text', type: 'textarea' },
      {
        key: 'items',
        type: 'list',
        item: [{ key: 'text', type: 'textarea' }, { key: 'name', type: 'text' }, { key: 'role', type: 'text' }, { key: 'avatar', type: 'image' }],
      },
    ],
  },
  {
    key: 'cta',
    variants: ['cta_gradient', 'cta_banner', 'cta_card', 'cta_dark', 'cta_minimal', 'cta_split', 'cta_wave'],
    fields: [
      { key: 'title', type: 'text' },
      { key: 'text', type: 'textarea' },
      button('btn'),
      { key: 'image', type: 'image' },
      { key: 'image_alt', type: 'text' },
    ],
  },
  {
    key: 'faq',
    variants: ['faq_accordion', 'faq_cards', 'faq_centered', 'faq_columns', 'faq_minimal'],
    fields: [
      { key: 'title', type: 'text' },
      { key: 'text', type: 'textarea' },
      { key: 'items', type: 'list', item: [{ key: 'q', type: 'text' }, { key: 'a', type: 'textarea' }] },
    ],
  },
  {
    key: 'newsletter',
    variants: ['newsletter', 'newsletter_banner', 'newsletter_card', 'newsletter_dark', 'newsletter_minimal'],
    fields: [
      { key: 'title', type: 'text' },
      { key: 'text', type: 'textarea' },
    ],
  },
];

/** Famille à laquelle appartient un nom de section (hero_split → hero). */
export function familyOf(section) {
  return SECTION_FAMILIES.find((f) => f.variants.includes(section))?.key ?? null;
}

export const ALL_VARIANTS = SECTION_FAMILIES.flatMap((f) => f.variants);

/**
 * Champs affichés dans le corps de la page, où une mise en forme a un sens : on y
 * accepte la mise en valeur, la couleur et le lien. Tous les autres champs finissent
 * dans un attribut HTML (`alt`, `href`) ou dans une balise `<title>` : texte brut.
 */
const INLINE_FIELD_KEYS = new Set(['title', 'text', 'badge', 'features', 'q', 'a', 'number', 'label', 'role']);
const isInlineField = (field) => INLINE_FIELD_KEYS.has(field.key) && !['image', 'number', 'button'].includes(field.type);

// Le catalogue est envoyé tel quel à l'interface : elle y lit quels champs sont enrichis.
for (const family of SECTION_FAMILIES) {
  for (const field of family.fields) {
    field.inline = isInlineField(field);
    for (const sub of field.item ?? []) sub.inline = isInlineField(sub);
  }
}

const plainDeep = (value) => {
  if (typeof value === 'string') return sanitizePlain(value);
  if (Array.isArray(value)) return value.map(plainDeep);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plainDeep(v)]));
  return value;
};

function sanitizeField(field, raw) {
  switch (field.type) {
    case 'button': {
      const button = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      return { ...button, text: sanitizeInline(String(button.text ?? '')), url: sanitizeUrl(button.url) };
    }
    case 'list': {
      if (!Array.isArray(raw)) return [];
      const subs = new Map((field.item ?? []).map((f) => [f.key, f]));
      return raw.slice(0, 40).map((item) => {
        if (!item || typeof item !== 'object') return {};
        return Object.fromEntries(
          Object.entries(item).map(([key, value]) => [key, subs.has(key) ? sanitizeField(subs.get(key), value) : plainDeep(value)]),
        );
      });
    }
    case 'strings':
      return Array.isArray(raw) ? raw.slice(0, 40).map((v) => (field.inline ? sanitizeInline(String(v ?? '')) : sanitizePlain(String(v ?? '')))) : [];
    case 'number':
      return Number.isFinite(Number(raw)) ? Number(raw) : 0;
    case 'image':
      return sanitizePlain(String(raw ?? ''));
    default:
      return field.inline ? sanitizeInline(String(raw ?? '')) : sanitizePlain(String(raw ?? ''));
  }
}

/**
 * Contenus de la page d'accueil, filtrés selon le contexte d'affichage de chaque champ.
 * Les gabarits du parc affichent ces valeurs sans échappement : ce filtre est la seule
 * barrière entre un compte du back-office et le HTML servi aux visiteurs.
 */
export function sanitizeHomepage(homepage) {
  if (!homepage || typeof homepage !== 'object' || Array.isArray(homepage)) return {};
  const families = new Map(SECTION_FAMILIES.map((f) => [f.key, f]));
  const out = {};
  for (const [key, value] of Object.entries(homepage)) {
    const family = families.get(key);
    if (!family || !value || typeof value !== 'object' || Array.isArray(value)) {
      out[key] = plainDeep(value);
      continue;
    }
    const byKey = new Map(family.fields.map((f) => [f.key, f]));
    out[key] = Object.fromEntries(
      Object.entries(value).map(([field, raw]) => [field, byKey.has(field) ? sanitizeField(byKey.get(field), raw) : plainDeep(raw)]),
    );
  }
  return out;
}

// ───────────────────────── Validation ─────────────────────────

const MAX_JSON = 400 * 1024;
const bad = (key, vars) => new AppError(key, { status: 400, vars });

const str = (value, { max = 400, field }) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw bad('errors.design_field_invalid', { field });
  if (value.length > max) throw bad('errors.design_field_too_long', { field, max });
  return value;
};

const inList = (value, list, field) => {
  if (value === undefined || value === null) return undefined;
  if (!list.includes(value)) throw bad('errors.design_value_invalid', { field, value: String(value).slice(0, 40) });
  return value;
};

/** Applique le filtre seulement quand la valeur existe : `undefined` reste `undefined`. */
const inline = (value) => (value === undefined ? undefined : sanitizeInline(value));
const plain = (value) => (value === undefined ? undefined : sanitizePlain(value));

const COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Charte graphique : uniquement des couleurs hexadécimales, rien d'exécutable. */
export function validateStyle(style) {
  const out = {};
  for (const [name, value] of Object.entries(style ?? {})) {
    if (!/^[a-z0-9-]{1,40}$/i.test(name)) throw bad('errors.design_value_invalid', { field: 'style', value: name.slice(0, 40) });
    const color = String(value).trim();
    if (!COLOR_RE.test(color)) throw bad('errors.design_color_invalid', { field: name, value: color.slice(0, 40) });
    out[name] = color.toLowerCase();
  }
  return out;
}

/**
 * Valide une configuration complète avant écriture.
 * `available` : sections réellement présentes sur CE site (l'éditeur ne doit jamais
 * proposer une section absente du serveur, qui produirait une page amputée).
 */
export function validateConfig(config, { available = ALL_VARIANTS } = {}) {
  if (!config || typeof config !== 'object') throw bad('errors.bad_request');
  if (JSON.stringify(config).length > MAX_JSON) throw bad('errors.design_too_large');

  const out = { ...config };
  out.site_name = inline(str(config.site_name, { max: 120, field: 'site_name' }));
  out.site_icon = plain(str(config.site_icon, { max: 40, field: 'site_icon' }));
  // Des slogans du parc contiennent déjà une mise en valeur : elle doit survivre.
  out.site_tagline = inline(str(config.site_tagline, { max: 300, field: 'site_tagline' }));
  out.site_lang = inList(config.site_lang, SITE_LANGS, 'site_lang');
  for (const key of ['header_nav', 'header_logo', 'header_cta', 'footer_style', 'category_style', 'article_style']) {
    if (config[key] !== undefined) out[key] = inList(config[key], PRESETS[key], key);
  }
  out.header_cta_text = inline(str(config.header_cta_text, { max: 120, field: 'header_cta_text' }));
  out.header_cta_url = config.header_cta_url === undefined ? undefined : sanitizeUrl(str(config.header_cta_url, { max: 300, field: 'header_cta_url' }));

  if (config.homepage_sections !== undefined) {
    const list = config.homepage_sections;
    if (!Array.isArray(list) || list.length > 14) throw bad('errors.design_sections_invalid');
    for (const section of list) {
      if (typeof section !== 'string' || !ALL_VARIANTS.includes(section)) throw bad('errors.design_section_unknown', { section: String(section).slice(0, 40) });
      if (!available.includes(section)) throw bad('errors.design_section_missing', { section });
    }
    out.homepage_sections = list;
  }

  if (config.categories !== undefined) {
    const cats = config.categories;
    if (!cats || typeof cats !== 'object' || Array.isArray(cats)) throw bad('errors.design_field_invalid', { field: 'categories' });
    const clean = {};
    for (const [slug, value] of Object.entries(cats)) {
      if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(slug)) throw bad('errors.design_value_invalid', { field: 'categories', value: slug.slice(0, 40) });
      clean[slug] = {
        name: str(value?.name, { max: 120, field: `categories.${slug}.name` }) ?? slug,
        icon: str(value?.icon, { max: 16, field: `categories.${slug}.icon` }) ?? '',
        description: str(value?.description, { max: 300, field: `categories.${slug}.description` }) ?? '',
      };
    }
    out.categories = clean;
  }

  if (config.footer_show !== undefined) {
    out.footer_show = {
      navigation: Boolean(config.footer_show?.navigation),
      social: Boolean(config.footer_show?.social),
    };
  }

  if (config.homepage !== undefined) {
    if (!config.homepage || typeof config.homepage !== 'object' || Array.isArray(config.homepage)) throw bad('errors.design_field_invalid', { field: 'homepage' });
    out.homepage = sanitizeHomepage(config.homepage);
  }

  return out;
}

/** Métadonnées d'article : bornes simples, le contenu HTML est traité à part. */
export function validateArticleMeta(meta) {
  if (!meta || typeof meta !== 'object') throw bad('errors.bad_request');
  const out = { ...meta };
  out.title = str(meta.title, { max: 300, field: 'title' }) ?? '';
  out.image = str(meta.image, { max: 200, field: 'image' }) ?? '';
  out.intro = str(meta.intro, { max: 2000, field: 'intro' }) ?? '';
  out.date = str(meta.date, { max: 60, field: 'date' }) ?? '';
  out.read_time = str(String(meta.read_time ?? ''), { max: 10, field: 'read_time' });
  out.author_name = str(meta.author_name, { max: 120, field: 'author_name' }) ?? '';
  out.author_bio = str(meta.author_bio, { max: 600, field: 'author_bio' }) ?? '';
  if (meta.tags !== undefined) {
    if (!Array.isArray(meta.tags) || meta.tags.length > 20) throw bad('errors.design_field_invalid', { field: 'tags' });
    out.tags = meta.tags.map((t) => str(t, { max: 60, field: 'tags' }) ?? '');
  }
  return out;
}

/** Corps d'article : bloc HTML, borné et sans balise exécutable. */
export function validateArticleContent(content) {
  if (typeof content !== 'string') throw bad('errors.bad_request');
  if (content.length > 400 * 1024) throw bad('errors.design_too_large');
  // Le corps est réinjecté dans un nowdoc PHP : le marqueur de fin ne doit pas y apparaître.
  if (/^\s*HTML;\s*$/m.test(content)) throw bad('errors.design_content_marker');
  if (/<\?php|<\?=|<script\b|<iframe\b|on[a-z]+\s*=/i.test(content)) throw bad('errors.design_content_unsafe');
  return content;
}

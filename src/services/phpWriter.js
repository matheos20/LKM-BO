/**
 * Génération du PHP écrit sur les sites : config.php, style.css et bloc de métadonnées
 * d'article. Le rendu imite la mise en forme d'origine, afin qu'un fichier modifié par
 * le back-office reste lisible et comparable à un fichier généré par les outils du parc.
 *
 * Toute valeur produite ici est relue ensuite par PHP sur le serveur, et comparée à
 * l'intention (aller-retour) avant publication : une erreur d'échappement ne peut pas
 * atteindre le site.
 */

const INDENT = '    ';

/** Chaîne PHP entre apostrophes : seuls l'antislash et l'apostrophe sont à protéger. */
export const phpString = (value) => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isScalar = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

function scalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '0';
  return phpString(value);
}

/** Un tableau ne contenant que des scalaires peut tenir sur une ligne, comme dans l'original. */
const flat = (value) =>
  (Array.isArray(value) && value.every(isScalar)) || (isPlainObject(value) && Object.values(value).every(isScalar));

export function phpValue(value, depth = 0) {
  if (isScalar(value) || value === undefined) return scalar(value);

  const pad = INDENT.repeat(depth + 1);
  const close = INDENT.repeat(depth);

  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    const inline = `[${value.map((v) => phpValue(v, depth + 1)).join(', ')}]`;
    if (flat(value) && inline.length + depth * 4 <= 150) return inline;
    return `[\n${value.map((v) => `${pad}${phpValue(v, depth + 1)},`).join('\n')}\n${close}]`;
  }

  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  if (!entries.length) return '[]';
  const inline = `[${entries.map(([k, v]) => `${phpString(k)} => ${phpValue(v, depth + 1)}`).join(', ')}]`;
  if (flat(value) && inline.length + depth * 4 <= 150) return inline;
  return `[\n${entries.map(([k, v]) => `${pad}${phpString(k)} => ${phpValue(v, depth + 1)},`).join('\n')}\n${close}]`;
}

const assign = (name, value) => `$${name} = ${phpValue(value)};`;

/**
 * Écrit config.php dans l'ordre et avec les commentaires du modèle d'origine.
 * `extraVars` reprend telles quelles d'éventuelles variables non gérées par l'éditeur,
 * pour ne jamais appauvrir un fichier existant.
 */
export function buildConfigPhp(config, extraVars = {}) {
  const has = (k) => config[k] !== undefined && config[k] !== null;
  const out = ['<?php'];

  out.push('// Identité du site');
  for (const key of ['site_name', 'site_icon', 'site_tagline', 'site_lang']) {
    if (has(key)) out.push(assign(key, config[key]));
  }

  out.push('', '// Preset header');
  for (const key of ['header_nav', 'header_logo', 'header_cta']) if (has(key)) out.push(assign(key, config[key]));
  // Le libellé et l'URL du bouton ne sont écrits que si un bouton est demandé.
  if (config.header_cta && config.header_cta !== 'none') {
    for (const key of ['header_cta_text', 'header_cta_url']) if (has(key)) out.push(assign(key, config[key]));
  }

  out.push('', '// Preset footer');
  if (has('footer_style')) out.push(assign('footer_style', config.footer_style));
  if (has('footer_show')) out.push(assign('footer_show', config.footer_show));

  out.push('', '// Preset category');
  if (has('category_style')) out.push(assign('category_style', config.category_style));

  out.push('', '// Categories');
  if (has('categories')) out.push(assign('categories', config.categories));

  out.push('', '// Homepage sections');
  if (has('homepage_sections')) out.push(assign('homepage_sections', config.homepage_sections));

  out.push('', '// Homepage data');
  if (has('homepage')) out.push(assign('homepage', config.homepage));

  if (has('article_style')) out.push('', assign('article_style', config.article_style));

  const extras = Object.entries(extraVars ?? {});
  if (extras.length) {
    out.push('', '// Variables conservées telles quelles par le back-office');
    for (const [name, exported] of extras) out.push(`$${name} = ${exported};`);
  }

  return `${out.join('\n')}\n`;
}

/** Charte graphique : bloc :root de style.css, dans l'ordre fourni. */
export function buildStyleCss(vars) {
  const lines = Object.entries(vars).map(([name, value]) => `${INDENT}--${name}: ${String(value).trim()};`);
  return `:root {\n${lines.join('\n')}\n}\n`;
}

/** Bloc $article_meta = [...]; d'un article, mise en forme identique au modèle. */
export function buildArticleMetaBlock(meta) {
  const order = ['title', 'image', 'intro', 'date', 'read_time', 'author_name', 'author_bio', 'tags'];
  const keys = [...order.filter((k) => meta[k] !== undefined), ...Object.keys(meta).filter((k) => !order.includes(k))];
  const lines = keys.map((k) => `${INDENT}${phpString(k)} => ${phpValue(meta[k], 1)},`);
  return `$article_meta = [\n${lines.join('\n')}\n];`;
}

/**
 * Remplace, dans le fichier brut d'un article, le bloc de métadonnées et le corps HTML,
 * en laissant le reste intact (en-tête, garde $meta_only, catégorie, include final).
 */
export function spliceArticle(raw, offsets, { metaBlock, content }) {
  const { metaStart, metaEnd, bodyStart, bodyEnd } = offsets ?? {};
  // Les positions viennent de PHP, qui compte en OCTETS. Le découpage se fait donc sur un
  // tampon d'octets : dans une chaîne JavaScript, une apostrophe typographique (trois
  // octets pour un seul caractère) décalerait la coupe, et le fichier produit perdrait la
  // fin de son bloc de texte — PHP refuserait alors de le lire.
  const bytes = (value) => (Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8'));
  let out = bytes(raw);
  // Du plus loin vers le plus proche : les positions antérieures restent valides.
  if (content !== undefined) {
    if (!Number.isInteger(bodyStart) || !Number.isInteger(bodyEnd)) throw new Error('Corps de l\'article introuvable');
    out = Buffer.concat([out.subarray(0, bodyStart), bytes(content), out.subarray(bodyEnd)]);
  }
  if (metaBlock !== undefined) {
    if (!Number.isInteger(metaStart) || !Number.isInteger(metaEnd)) throw new Error('Métadonnées de l\'article introuvables');
    out = Buffer.concat([out.subarray(0, metaStart), bytes(metaBlock), out.subarray(metaEnd)]);
  }
  return out;
}

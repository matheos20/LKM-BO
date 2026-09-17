import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildArticleMetaBlock, buildConfigPhp, buildStyleCss, phpString, phpValue, spliceArticle } from '../src/services/phpWriter.js';
import { readFile } from 'node:fs/promises';
import { normalizeColor, sanitizeInline, sanitizePlain } from '../src/services/htmlText.js';
import { ALL_VARIANTS, SECTION_FAMILIES, familyOf, validateArticleContent, validateConfig, validateStyle } from '../src/services/siteCatalog.js';
import { preparePreviewHtml } from '../src/services/siteService.js';

const key = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err.key ?? err.message;
  }
};

test('génération PHP : échappement et mise en forme', () => {
  assert.equal(phpString("L'été"), "'L\\'été'");
  assert.equal(phpString('C:\\chemin'), "'C:\\\\chemin'");
  assert.equal(phpValue(['a', 'b']), "['a', 'b']");
  assert.equal(phpValue({ text: 'Voir', url: '/' }), "['text' => 'Voir', 'url' => '/']");
  assert.equal(phpValue(true), 'true');
  assert.equal(phpValue(30), '30');
  // Un contenu long passe sur plusieurs lignes, comme dans les fichiers d'origine.
  assert.match(phpValue({ title: 'x'.repeat(200) }), /^\[\n {4}'title' => 'x+',\n\]$/);
});

test('config.php : structure, bouton conditionnel, variables préservées', () => {
  const php = buildConfigPhp(
    {
      site_name: "L'Atelier",
      site_icon: '&#x1F4F0;',
      site_tagline: 'Slogan',
      site_lang: 'FR',
      header_nav: 'inline',
      header_logo: 'left',
      header_cta: 'button',
      header_cta_text: 'Voir →',
      header_cta_url: '/equipment/',
      footer_style: 'wave',
      footer_show: { navigation: true, social: false },
      category_style: 'classic',
      categories: { news: { name: 'Actu', icon: '📰', description: 'Fil' } },
      homepage_sections: ['hero_split', 'cta_gradient'],
      homepage: { hero: { title: 'Bonjour <em>monde</em>' } },
      article_style: 'minimal',
    },
    { $legacy: "'valeur'" },
  );

  assert.match(php, /^<\?php\n\/\/ Identité du site\n/);
  assert.match(php, /\$site_name = 'L\\'Atelier';/);
  assert.match(php, /\$header_cta_text = 'Voir →';/);
  assert.match(php, /\$categories = \[\n {4}'news' => \['name' => 'Actu'/);
  assert.match(php, /\$homepage_sections = \['hero_split', 'cta_gradient'\];/);
  assert.match(php, /\$article_style = 'minimal';/);
  assert.match(php, /\$\$legacy = 'valeur';|\$legacy = 'valeur';/);

  // Sans bouton d'en-tête, ni le libellé ni l'URL ne doivent être écrits.
  const sansBouton = buildConfigPhp({ header_cta: 'none', header_cta_text: 'Résidu', header_cta_url: '/x' });
  assert.ok(!sansBouton.includes('header_cta_text'));
  assert.ok(!sansBouton.includes('header_cta_url'));
});

test('style.css : bloc :root régénéré dans l\'ordre', () => {
  const css = buildStyleCss({ primary: '#D0E12B', text: '#373D26' });
  assert.equal(css, ':root {\n    --primary: #D0E12B;\n    --text: #373D26;\n}\n');
});

test('article : remplacement chirurgical des métadonnées et du corps', () => {
  const raw = [
    '<?php',
    "$article_meta = [",
    "    'title' => 'Ancien titre',",
    "    'tags' => ['A'],",
    '];',
    'if (isset($meta_only) && $meta_only) return;',
    "$category = 'news';",
    "$content = <<<'HTML'",
    '<h2>Ancien</h2>',
    'HTML;',
    "include __DIR__ . '/../article.php';",
    '',
  ].join('\n');

  const offsets = {
    metaStart: raw.indexOf('$article_meta'),
    metaEnd: raw.indexOf('\n];') + 3,
    bodyStart: raw.indexOf("<<<'HTML'\n") + "<<<'HTML'\n".length,
    bodyEnd: raw.indexOf('\nHTML;'),
  };

  const out = spliceArticle(raw, offsets, {
    metaBlock: buildArticleMetaBlock({ title: 'Nouveau titre', tags: ['B'] }),
    content: '<h2>Nouveau</h2>\n<p>Texte</p>',
  });

  assert.match(out, /\$article_meta = \[\n {4}'title' => 'Nouveau titre',\n {4}'tags' => \['B'\],\n\];/);
  assert.ok(out.includes('<h2>Nouveau</h2>\n<p>Texte</p>\nHTML;'));
  // Le reste du fichier est intact.
  assert.ok(out.includes('if (isset($meta_only) && $meta_only) return;'));
  assert.ok(out.includes("$category = 'news';"));
  assert.ok(out.includes("include __DIR__ . '/../article.php';"));
  assert.ok(!out.includes('Ancien'));
});

test('validation de la configuration', () => {
  const available = ['hero_split', 'cta_gradient'];
  assert.equal(key(() => validateConfig({ homepage_sections: ['hero_split'] }, { available })), null);
  assert.equal(key(() => validateConfig({ homepage_sections: ['inconnu'] }, { available })), 'errors.design_section_unknown');
  assert.equal(key(() => validateConfig({ homepage_sections: ['faq_columns'] }, { available })), 'errors.design_section_missing');
  assert.equal(key(() => validateConfig({ homepage_sections: new Array(20).fill('hero_split') }, { available })), 'errors.design_sections_invalid');
  assert.equal(key(() => validateConfig({ site_lang: 'ZZ' })), 'errors.design_value_invalid');
  assert.equal(key(() => validateConfig({ header_nav: 'inexistant' })), 'errors.design_value_invalid');
  assert.equal(key(() => validateConfig({ site_name: 'x'.repeat(500) })), 'errors.design_field_too_long');
  assert.equal(key(() => validateConfig({ categories: { 'MAJUSCULE!': {} } })), 'errors.design_value_invalid');

  const clean = validateConfig({ footer_show: { navigation: 'oui', social: 0 }, categories: { news: { name: 'Actu' } } });
  assert.deepEqual(clean.footer_show, { navigation: true, social: false });
  assert.deepEqual(clean.categories.news, { name: 'Actu', icon: '', description: '' });
  assert.equal(familyOf('hero_split'), 'hero');
  assert.equal(familyOf('inconnu'), null);
});

test('validation de la charte : couleurs hexadécimales uniquement', () => {
  assert.deepEqual(validateStyle({ primary: '#D0E12B' }), { primary: '#d0e12b' });
  assert.equal(key(() => validateStyle({ primary: 'red' })), 'errors.design_color_invalid');
  assert.equal(key(() => validateStyle({ primary: '#fff; background:url(x)' })), 'errors.design_color_invalid');
  assert.equal(key(() => validateStyle({ 'mauvais nom': '#ffffff' })), 'errors.design_value_invalid');
});

test('validation du contenu d\'article', () => {
  assert.equal(key(() => validateArticleContent('<h2>Titre</h2>\n<p>Texte</p>')), null);
  assert.equal(key(() => validateArticleContent('<script>alert(1)</script>')), 'errors.design_content_unsafe');
  assert.equal(key(() => validateArticleContent('<?php system("x"); ?>')), 'errors.design_content_unsafe');
  assert.equal(key(() => validateArticleContent('<p onclick="x()">a</p>')), 'errors.design_content_unsafe');
  // Le marqueur de fin du nowdoc ne doit jamais apparaître seul dans le corps.
  assert.equal(key(() => validateArticleContent('<p>a</p>\nHTML;\n<p>b</p>')), 'errors.design_content_marker');
});

test('prévisualisation : page rendue inoffensive et autonome', () => {
  const html = [
    '<html><head>',
    '<link rel="stylesheet" href="/style.css?v=1">',
    '<link rel="preload" href="/base.css?v=2" as="style" onload="this.rel=\'stylesheet\'">',
    '</head><body onload="go()">',
    '<img src="/images/1-600.jpg" srcset="/images/1-400.webp 400w, /images/1-900.webp 900w">',
    '<script>alert(1)</script>',
    '<a href="/contact/">Contact</a>',
    '</body></html>',
  ].join('\n');

  const out = preparePreviewHtml(html, 'exemple.com', { primary: '#c81e4a' }, true);
  assert.ok(!/<script/i.test(out), 'aucun script ne doit subsister');
  assert.ok(!/onload=/i.test(out), 'aucun gestionnaire d\'événement ne doit subsister');
  assert.ok(out.includes('rel="stylesheet" href="https://exemple.com/base.css?v=2"'), 'la feuille préchargée devient une feuille normale');
  assert.ok(out.includes('src="https://exemple.com/images/1-600.jpg"'));
  assert.ok(out.includes('srcset="https://exemple.com/images/1-400.webp 400w, https://exemple.com/images/1-900.webp 900w"'));
  assert.ok(out.includes('href="https://exemple.com/contact/"'));
  assert.ok(out.includes('lkm-draft-theme') && out.includes('--primary: #c81e4a;'));
  assert.ok(out.includes('PRÉVISUALISATION — brouillon non publié'));
  assert.ok(out.includes('noindex'));

  const published = preparePreviewHtml('<html><head></head><body></body></html>', 'exemple.com', {}, false);
  assert.ok(published.includes('état actuellement en ligne'));
});

test('prévisualisation : polices du site embarquées dans la page', () => {
  const html = [
    '<html><head>',
    '<link rel="preload" href="/fonts/inter-latin.woff2" as="font" type="font/woff2" crossorigin>',
    '<style>@font-face{font-family:Inter;src:url(/fonts/inter-latin.woff2) format("woff2")}</style>',
    '<style>@font-face{font-family:Autre;src:url(/fonts/absente.woff2)}</style>',
    '</head><body></body></html>',
  ].join('\n');

  const out = preparePreviewHtml(html, 'exemple.com', {}, false, { 'inter-latin.woff2': 'QUJD' });
  assert.ok(!/as="font"/.test(out), 'le préchargement de police, refusé entre origines, est retiré');
  assert.ok(out.includes('url(data:font/woff2;base64,QUJD)'), 'la police connue est embarquée');
  assert.ok(!out.includes('/fonts/inter-latin.woff2'), 'plus aucune adresse distante pour cette police');
  // Une police absente du serveur garde son adresse : mieux vaut une tentative qu'une règle cassée.
  assert.ok(out.includes('/fonts/absente.woff2'));
});

test('chaque gabarit du parc a un schéma et un intitulé lisibles, dans toutes les langues', async () => {
  const read = async (rel) => readFile(new URL(rel, import.meta.url), 'utf8');
  const source = await read('../public/js/blocks.js');

  const slice = (start) => source.slice(source.indexOf(start), source.indexOf('\n};', source.indexOf(start)));
  const shapes = new Set([...slice('const SHAPES = {').matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]));
  const layouts = new Map(
    [...slice('const LAYOUTS = {').matchAll(/^ {2}(\w+): \{ shape: '(\w+)'(?:, tone: '(\w+)')? \}/gm)].map((m) => [m[1], { shape: m[2], tone: m[3] }]),
  );

  // Aucun gabarit du catalogue ne doit retomber sur son nom technique.
  for (const variant of ALL_VARIANTS) assert.ok(layouts.has(variant), `gabarit sans schéma : ${variant}`);
  for (const { shape } of layouts.values()) assert.ok(shapes.has(shape), `schéma inconnu : ${shape}`);

  for (const lang of ['fr', 'en', 'es', 'it', 'pt', 'de']) {
    const { design } = JSON.parse(await read(`../locales/${lang}.json`));
    for (const { shape, tone } of layouts.values()) {
      assert.equal(typeof design.layout[shape], 'string', `${lang} : disposition « ${shape} » non traduite`);
      if (tone) assert.equal(typeof design.tone[tone], 'string', `${lang} : nuance « ${tone} » non traduite`);
    }
    for (const family of SECTION_FAMILIES) {
      assert.equal(typeof design.family[family.key], 'string', `${lang} : famille « ${family.key} » non traduite`);
      assert.equal(typeof design.purpose[family.key], 'string', `${lang} : rôle de « ${family.key} » non traduit`);
    }
  }
});

test('couleurs : hex et rgb ramenés à une seule écriture', () => {
  assert.equal(normalizeColor('#C81E4A'), '#c81e4a');
  assert.equal(normalizeColor('#fff'), '#ffffff');
  assert.equal(normalizeColor(' rgb(200, 30, 74) '), '#c81e4a');
  assert.equal(normalizeColor('rgba(0,0,0,0.5)'), '#000000');
  assert.equal(normalizeColor('red'), null);
  assert.equal(normalizeColor('#12345'), null);
  assert.equal(normalizeColor('rgb(300,0,0)'), null);
  assert.equal(normalizeColor('expression(alert(1))'), null);
});

test('texte enrichi : la mise en forme du parc survit, le reste est neutralisé', () => {
  // Ce qui existe déjà dans les fichiers du parc doit ressortir intact.
  assert.equal(sanitizeInline('<em>cooking</em>'), '<em>cooking</em>');
  assert.equal(sanitizeInline('<a href="https://www.keobiz.fr/">Keobiz</a>'), '<a href="https://www.keobiz.fr/">Keobiz</a>');
  assert.equal(sanitizeInline('Ligne<br>suite'), 'Ligne<br>suite');
  assert.equal(sanitizeInline('<span style="color:#C81E4A">rouge</span>'), '<span style="color:#c81e4a">rouge</span>');
  assert.equal(sanitizeInline('<span style="color:rgb(200,30,74)">rouge</span>'), '<span style="color:#c81e4a">rouge</span>');

  // Tout le reste est reconstruit : aucun attribut reçu n'est recopié.
  assert.equal(sanitizeInline('<img src=x onerror=alert(1)>'), '');
  assert.equal(sanitizeInline('<span style="color:#fff" onmouseover="vol()">x</span>'), '<span style="color:#ffffff">x</span>');
  assert.equal(sanitizeInline('<a href="javascript:alert(1)">clic</a>'), 'clic');
  assert.equal(sanitizeInline('<a href="/page/" target="_self" rel="me nofollow">a</a>'), '<a href="/page/" rel="nofollow">a</a>');
  assert.ok(!sanitizeInline('<script>alert(1)</script>').includes('<'));
  assert.equal(sanitizeInline('<b><span style="color:#111">mal fermé</b>'), '<b><span style="color:#111111">mal fermé</span></b>');
  assert.equal(sanitizeInline('5 < 7'), '5 &lt; 7');

  // Un champ qui finit dans un attribut n'accepte aucune balise.
  assert.equal(sanitizePlain('<b>Sarah</b> Mitchell'), 'Sarah Mitchell');
  assert.equal(sanitizePlain('"><script>alert(1)</script>'), '" alert(1)');
});

test('configuration : chaque champ est filtré selon son contexte d\'affichage', () => {
  const clean = validateConfig({
    site_tagline: 'Un regard, une <em>histoire</em> partagée.',
    header_cta_url: '/equipment/"><script>x</script>',
    homepage: {
      hero: {
        title: 'Discover the art of French <span style="color:#C81E4A">cooking</span>',
        image_alt: '<img src=x onerror=alert(1)>Photo',
        btn_primary: { text: '<em>Voir</em>', url: 'javascript:alert(1)' },
      },
      testimonials: {
        items: [{ text: '<span style="color:#123456">Excellent</span>', name: '<b>Sarah</b>', avatar: 'x<script>' }],
      },
      meta_description: 'Résumé <em>soigné</em>',
    },
  });

  assert.equal(clean.site_tagline, 'Un regard, une <em>histoire</em> partagée.');
  assert.equal(clean.header_cta_url, '/equipment/', "l'adresse s'arrete avant tout caractere permettant de sortir de l'attribut");
  assert.equal(validateConfig({ header_cta_url: 'javascript:alert(1)' }).header_cta_url, '');
  assert.equal(validateConfig({ header_cta_url: '/equipment/' }).header_cta_url, '/equipment/');
  assert.equal(clean.homepage.hero.title, 'Discover the art of French <span style="color:#c81e4a">cooking</span>');
  assert.equal(clean.homepage.hero.image_alt, 'Photo');
  assert.equal(clean.homepage.hero.btn_primary.text, '<em>Voir</em>');
  assert.equal(clean.homepage.hero.btn_primary.url, '', 'une adresse exécutable est retirée du bouton');
  assert.equal(clean.homepage.testimonials.items[0].text, '<span style="color:#123456">Excellent</span>');
  assert.equal(clean.homepage.testimonials.items[0].name, 'Sarah');
  assert.ok(!clean.homepage.testimonials.items[0].avatar.includes('<'));
  // La description pour les moteurs est réinjectée dans un attribut : texte brut.
  assert.equal(clean.homepage.meta_description, 'Résumé soigné');
});

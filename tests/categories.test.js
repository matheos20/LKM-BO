import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CATEGORY_FILES, CATEGORY_LIST } from '../src/services/phpScripts.js';
import { normalizeRequest, slugify } from '../src/services/categoryService.js';

test('rubriques : le nom donne l’adresse', () => {
  assert.equal(slugify('Sport'), 'sport');
  assert.equal(slugify('Vie quotidienne'), 'vie-quotidienne');
  assert.equal(slugify('Santé & Bien-être'), 'sante-bien-etre');
  assert.equal(slugify("L'actualité"), 'lactualite');
  assert.equal(slugify('  Jeux   vidéo  '), 'jeux-video');
  assert.equal(slugify('!!!'), '');
  assert.equal(slugify(''), '');
});

test('rubriques : la demande est nettoyée avant d’atteindre le serveur', () => {
  const out = normalizeRequest({
    'EXEMPLE.com': [
      { name: 'Sport' },
      { name: '  Sport  ' }, // même adresse : un seul passage
      { name: '' }, // sans nom : écartée
      { name: 'Vie quotidienne' },
    ],
    'sans-rubrique.fr': [],
    '': [{ name: 'Sport' }],
  });
  assert.deepEqual(Object.keys(out), ['exemple.com']);
  assert.deepEqual(out['exemple.com'], [
    { slug: 'sport', name: 'Sport' },
    { slug: 'vie-quotidienne', name: 'Vie quotidienne' },
  ]);

  // Une demande sans rien d'exploitable ne part pas.
  assert.deepEqual(normalizeRequest({ 'exemple.com': [{ name: '###' }] }), {});
  assert.deepEqual(normalizeRequest(null), {});
});

// ── Le script serveur, exécuté par PHP ─────────────────────────────────────
const php = spawnSync('php', ['-v'], { encoding: 'utf8' });
const phpAbsent = php.status !== 0;

const SITE = {
  'config.php': "<?php\n$site_lang = 'UK';\n$categories = [\n    'hardware' => ['name' => 'Hardware', 'icon' => '🖥️', 'description' => 'Components'],\n];\n",
  'category.php': "<?php\n// moteur de rubrique\n",
  'hardware/index.php': "<?php\n$category = 'hardware';\ninclude __DIR__ . '/../category.php';\n",
  'wp_summary.json': JSON.stringify({ articles_wp_published: 12, wp_categories: 1, wp_categories_list: [{ slug: 'hardware', name: 'Hardware' }] }),
};

function lancer(fichiers, request, mode = 'scan', operation = 'add') {
  const root = mkdtempSync(join(tmpdir(), 'lkm-cat-'));
  try {
    for (const [rel, contenu] of Object.entries(fichiers)) {
      const chemin = join(root, 'exemple.com', 'public_html', rel);
      mkdirSync(join(chemin, '..'), { recursive: true });
      writeFileSync(chemin, contenu, 'utf8');
    }
    const res = spawnSync('php', [], {
      input: CATEGORY_FILES,
      encoding: 'utf8',
      env: {
        ...process.env,
        LKM_ROOT: root,
        LKM_MODE: mode,
        LKM_OP: operation,
        LKM_B64: Buffer.from(JSON.stringify(normalizeRequest(request))).toString('base64'),
      },
    });
    assert.equal(res.status, 0, res.stderr);
    const site = JSON.parse(res.stdout).sites[0];
    // Les fichiers sont relus AVANT le ménage : le dossier n'existe plus au retour.
    const apres = {};
    for (const rel of [...Object.keys(fichiers), 'sport/index.php', 'news/index.php', 'hardware/mon-article.php']) {
      try {
        apres[rel] = readFileSync(join(root, 'exemple.com', 'public_html', rel), 'utf8');
      } catch {
        apres[rel] = null;
      }
    }
    site.lire = (rel) => apres[rel];
    site.existe = (rel) => apres[rel] !== null && apres[rel] !== undefined;
    return site;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const DEMANDE = { 'exemple.com': [{ name: 'Sport' }, { name: 'Hardware' }] };

test('rubriques : la vérification n’écrit rien', { skip: phpAbsent && 'php absent' }, () => {
  const site = lancer(SITE, DEMANDE);
  const par = Object.fromEntries(site.items.map((i) => [i.slug, i]));
  // Chaque rubrique tient en trois pièces, montrées séparément : c'est ce qui permet
  // de rattraper un site à moitié fait.
  assert.deepEqual([par.sport.dir, par.sport.config, par.sport.json], [false, false, false]);
  assert.deepEqual([par.hardware.dir, par.hardware.config, par.hardware.json], [true, true, true]);
  assert.equal(site.existe('sport/index.php'), false); // rien n'a été créé
  assert.equal(JSON.parse(site.lire('wp_summary.json')).wp_categories, 1);
});

test('rubriques : la création pose la page et le résumé, sans toucher l’existant', { skip: phpAbsent && 'php absent' }, () => {
  const site = lancer(SITE, DEMANDE, 'apply');
  const par = Object.fromEntries(site.items.map((i) => [i.slug, i]));
  assert.deepEqual(par.sport.done.sort(), ['dir', 'json']); // config.php est écrit par le back-office
  assert.deepEqual(par.hardware.done, []); // déjà en place : intouchée

  assert.equal(site.lire('sport/index.php'), "<?php\n$category = 'sport';\ninclude __DIR__ . '/../category.php';\n");
  const resume = JSON.parse(site.lire('wp_summary.json'));
  assert.equal(resume.wp_categories, 2);
  assert.deepEqual(resume.wp_categories_list.map((c) => c.slug), ['hardware', 'sport']);
  assert.equal(resume.articles_wp_published, 12); // le reste du fichier est conservé
  assert.match(site.lire('config.php'), /🖥️/); // ce script ne touche pas config.php
});

test('rubriques : un site sans moteur de rubrique est écarté', { skip: phpAbsent && 'php absent' }, () => {
  const { category, ...sansMoteur } = { ...SITE, category: null };
  delete sansMoteur['category.php'];
  const site = lancer(sansMoteur, DEMANDE, 'apply');
  assert.equal(site.error, 'engine');
  assert.deepEqual(site.items, []);
  assert.equal(site.existe('sport/index.php'), false);
});

test('rubriques : un site sans résumé WordPress reste traitable', { skip: phpAbsent && 'php absent' }, () => {
  const sansResume = { ...SITE };
  delete sansResume['wp_summary.json'];
  const site = lancer(sansResume, DEMANDE, 'apply');
  assert.equal(site.summary, false);
  assert.deepEqual(site.items.find((i) => i.slug === 'sport').done, ['dir']);
  assert.equal(site.existe('sport/index.php'), true);
});

// ── Suppression : la rubrique s'en va, les articles restent ────────────────

const SITE_AVEC_ARTICLES = {
  'config.php':
    "<?php\n$categories = [\n    'hardware' => ['name' => 'Hardware', 'icon' => '🖥️', 'description' => 'Components'],\n    'news' => ['name' => 'News', 'icon' => '', 'description' => ''],\n];\n",
  'category.php': "<?php\n// moteur\n",
  'hardware/index.php': "<?php\n$category = 'hardware';\ninclude __DIR__ . '/../category.php';\n",
  // Cette rubrique porte un article : son dossier doit survivre.
  'hardware/mon-article.php': "<?php\n$article_meta = ['title' => 'Un article'];\n",
  'news/index.php': "<?php\n$category = 'news';\ninclude __DIR__ . '/../category.php';\n",
  'wp_summary.json': JSON.stringify({
    articles_wp_published: 12,
    wp_categories: 2,
    wp_categories_list: [{ slug: 'hardware', name: 'Hardware' }, { slug: 'news', name: 'News' }],
  }),
};

const A_SUPPRIMER = { 'exemple.com': [{ name: 'Hardware' }, { name: 'News' }, { name: 'Absente' }] };

test('suppression : la vérification compte les articles sans rien toucher', { skip: phpAbsent && 'php absent' }, () => {
  const site = lancer(SITE_AVEC_ARTICLES, A_SUPPRIMER, 'scan', 'remove');
  const par = Object.fromEntries(site.items.map((i) => [i.slug, i]));
  // L'agent doit voir ce qu'il risque : cette rubrique porte un article.
  assert.equal(par.hardware.articles, 1);
  assert.equal(par.news.articles, 0);
  assert.deepEqual([par.hardware.config, par.hardware.json, par.hardware.dir], [true, true, true]);
  // Une rubrique absente du site se voit tout de suite.
  assert.deepEqual([par.absente.config, par.absente.json, par.absente.dir], [false, false, false]);
  // Le nom affiché vient de la configuration du site, pas de la saisie.
  assert.equal(par.hardware.name, 'Hardware');
  assert.equal(site.lire('hardware/index.php') !== null, true); // rien n'a bougé
});

test('suppression : la page part, l’article reste', { skip: phpAbsent && 'php absent' }, () => {
  const site = lancer(SITE_AVEC_ARTICLES, A_SUPPRIMER, 'apply', 'remove');
  const par = Object.fromEntries(site.items.map((i) => [i.slug, i]));

  assert.deepEqual(par.hardware.done.sort(), ['dir', 'json']); // config.php est écrit par le back-office
  assert.equal(site.existe('hardware/index.php'), false); // la page de la rubrique s'en va
  assert.equal(site.existe('hardware/mon-article.php'), true); // l'article, jamais
  assert.deepEqual(par.absente.done, []); // rien à retirer

  const resume = JSON.parse(site.lire('wp_summary.json'));
  assert.deepEqual(resume.wp_categories_list, []);
  assert.equal(resume.wp_categories, 0);
  assert.equal(resume.articles_wp_published, 12); // le reste du fichier est conservé
  assert.match(site.lire('config.php'), /hardware/); // ce script ne touche pas config.php
});

test('suppression : un site sans moteur de rubrique reste nettoyable', { skip: phpAbsent && 'php absent' }, () => {
  const sansMoteur = { ...SITE_AVEC_ARTICLES };
  delete sansMoteur['category.php'];
  const site = lancer(sansMoteur, A_SUPPRIMER, 'apply', 'remove');
  // À la création, l'absence de category.php écarte le site ; à la suppression, non :
  // il faut justement pouvoir nettoyer un site incomplet.
  assert.equal(site.error, null ?? undefined);
  assert.equal(site.existe('news/index.php'), false);
});

test('import CSV : ce qu’un tableur écrit vraiment', async () => {
  const { parseCsv, parseTable } = await import('../public/js/categories.js');

  // Point-virgule, en-tête, et une rubrique dont le nom contient une virgule :
  // le fichier la protège par des guillemets, la relecture doit la garder entière.
  const csv = 'Domaine;CATEGORIE 1;CATEGORIE 2\npalmyr-oceana.fr;Sport;"Cuisine, recettes"\nautre.com;Voyages;\n';
  const lignes = parseTable(parseCsv(csv)).lignes;
  assert.deepEqual(lignes, [
    { domain: 'palmyr-oceana.fr', noms: ['Sport', 'Cuisine, recettes'] },
    { domain: 'autre.com', noms: ['Voyages'] },
  ]);

  // Sans en-tête, la première ligne est un site comme les autres.
  assert.deepEqual(parseTable(parseCsv('exemple.com,Sport\n')).lignes, [{ domain: 'exemple.com', noms: ['Sport'] }]);
  // Marque d'ordre des octets et fins de ligne Windows : Excel en met.
  assert.deepEqual(parseTable(parseCsv('﻿exemple.com,Sport\r\n')).lignes, [{ domain: 'exemple.com', noms: ['Sport'] }]);
  // Guillemet doublé à l'intérieur d'un champ.
  assert.deepEqual(parseTable(parseCsv('exemple.com,"Le ""bon"" coin"')).lignes, [{ domain: 'exemple.com', noms: ['Le "bon" coin'] }]);
  // Un fichier vide ne produit rien, et ne casse rien.
  assert.deepEqual(parseTable(parseCsv('')).lignes, []);

  // Tapé à la main, sans tabulation : la virgule sépare, comme l'agent s'y attend.
  assert.deepEqual(parseTable('exemple.com, Sport, Cuisine').lignes, [{ domain: 'exemple.com', noms: ['Sport', 'Cuisine'] }]);
});

// ── Supprimer une rubrique qu'on n'a pas créée ─────────────────────────────

// Le cas réel qui bloquait : sur le parc, 104 rubriques sur 4152 portent un nom
// dont slugify() ne retrouve pas la clé. « Finance &amp; real estate » se range
// sous « finance-real-estate » ; un agent qui tape le nom affiché ne l'atteint
// jamais. La clé doit donc voyager telle quelle.
test('rubriques : une clé réelle traverse la demande sans être abîmée', () => {
  const out = normalizeRequest({
    'exemple.com': [
      { slug: 'finance-real-estate', name: 'Finance & real estate' },
      { slug: 'woman-fashion', name: 'Woman / fashion' },
    ],
  });
  assert.deepEqual(
    out['exemple.com'].map((r) => r.slug),
    ['finance-real-estate', 'woman-fashion'],
  );
  // Sans clé fournie, c'est le nom qui la donne — et là, slugify se trompe de cible.
  assert.equal(normalizeRequest({ 'exemple.com': [{ name: 'Finance &amp; real estate' }] })['exemple.com'][0].slug, 'finance-amp-real-estate');
  // Une clé fournie mais invalide est rattrapée, jamais envoyée telle quelle.
  assert.equal(normalizeRequest({ 'exemple.com': [{ slug: 'Mon Dossier', name: 'X' }] })['exemple.com'][0].slug, 'mon-dossier');
  assert.equal(normalizeRequest({ 'exemple.com': [{ slug: '../etc', name: 'X' }] })['exemple.com'][0].slug, 'etc');
});

const SITE_PARC = {
  'config.php':
    "<?php\n$site_lang = 'UK';\n$categories = [\n" +
    "    'finance-real-estate' => ['name' => 'Finance &amp; real estate', 'icon' => '', 'description' => 'Money'],\n" +
    "    'tourism' => ['name' => 'Tourism', 'icon' => '', 'description' => 'Travel'],\n" +
    "    'MAJUSCULE' => ['name' => 'Rejetée', 'icon' => '', 'description' => ''],\n];\n",
  'category.php': '<?php\n',
  'finance-real-estate/index.php': "<?php\n$category = 'finance-real-estate';\n",
  'finance-real-estate/mon-article.php': "<?php\n$article_meta = ['title' => 'Un article'];\n",
  'tourism/index.php': "<?php\n$category = 'tourism';\n",
};

function lister(fichiers, domaines = ['exemple.com']) {
  const root = mkdtempSync(join(tmpdir(), 'lkm-cat-'));
  try {
    for (const [rel, contenu] of Object.entries(fichiers)) {
      const chemin = join(root, 'exemple.com', 'public_html', rel);
      mkdirSync(join(chemin, '..'), { recursive: true });
      writeFileSync(chemin, contenu, 'utf8');
    }
    const res = spawnSync('php', [], {
      input: CATEGORY_LIST,
      encoding: 'utf8',
      env: { ...process.env, LKM_ROOT: root, LKM_B64: Buffer.from(JSON.stringify(domaines)).toString('base64') },
    });
    assert.equal(res.status, 0, res.stderr);
    return JSON.parse(res.stdout).sites;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('rubriques : la liste des rubriques en place, telle que l’agent la coche', { skip: phpAbsent && 'php absent' }, () => {
  const [site] = lister(SITE_PARC);
  const par = Object.fromEntries(site.items.map((i) => [i.slug, i]));

  // Le nom est rendu lisible — l'agent voit ce que voit le visiteur — mais la clé,
  // elle, reste celle du serveur : c'est elle qui sert à viser la rubrique.
  assert.equal(par['finance-real-estate'].name, 'Finance & real estate');
  assert.equal(par['finance-real-estate'].articles, 1);
  assert.equal(par['finance-real-estate'].dir, true);
  // Une rubrique vide se distingue : son dossier partira, les autres non.
  assert.equal(par.tourism.articles, 0);
  // Une clé que le moteur du site ne sait pas servir n'est pas proposée.
  assert.equal(par.MAJUSCULE, undefined);
  assert.equal(site.items.length, 2);
});

test('rubriques : un site sans config.php est signalé, pas deviné', { skip: phpAbsent && 'php absent' }, () => {
  const [site] = lister({ 'category.php': '<?php\n' });
  assert.equal(site.error, 'missing');
  assert.deepEqual(site.items, []);
});

test('rubriques : supprimer retire la page, jamais les articles', { skip: phpAbsent && 'php absent' }, () => {
  // On vise par la CLÉ RÉELLE, comme le fait désormais l'écran après avoir lu le site.
  const demande = { 'exemple.com': [{ slug: 'finance-real-estate', name: 'Finance & real estate' }, { slug: 'tourism', name: 'Tourism' }] };
  const site = lancerParc(SITE_PARC, demande, 'apply', 'remove');
  const par = Object.fromEntries(site.items.map((i) => [i.slug, i]));

  assert.deepEqual(par['finance-real-estate'].done, ['dir']);
  // Ce qui compte : l'article survit, et son dossier avec lui.
  assert.equal(site.existe('finance-real-estate/mon-article.php'), true);
  assert.equal(site.existe('finance-real-estate/index.php'), false);
  // La rubrique vide, elle, ne laisse pas de dossier derrière elle.
  assert.equal(site.existe('tourism/index.php'), false);
});

/** Même harnais que `lancer`, mais sur l'arborescence d'un site du parc. */
function lancerParc(fichiers, request, mode, operation) {
  const root = mkdtempSync(join(tmpdir(), 'lkm-cat-'));
  try {
    for (const [rel, contenu] of Object.entries(fichiers)) {
      const chemin = join(root, 'exemple.com', 'public_html', rel);
      mkdirSync(join(chemin, '..'), { recursive: true });
      writeFileSync(chemin, contenu, 'utf8');
    }
    const res = spawnSync('php', [], {
      input: CATEGORY_FILES,
      encoding: 'utf8',
      env: {
        ...process.env,
        LKM_ROOT: root,
        LKM_MODE: mode,
        LKM_OP: operation,
        LKM_B64: Buffer.from(JSON.stringify(normalizeRequest(request))).toString('base64'),
      },
    });
    assert.equal(res.status, 0, res.stderr);
    const site = JSON.parse(res.stdout).sites[0];
    const apres = {};
    for (const rel of [...Object.keys(fichiers), 'tourism/index.php']) {
      try {
        apres[rel] = readFileSync(join(root, 'exemple.com', 'public_html', rel), 'utf8');
      } catch {
        apres[rel] = null;
      }
    }
    site.existe = (rel) => apres[rel] != null;
    return site;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

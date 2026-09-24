import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CATEGORY_FILES } from '../src/services/phpScripts.js';
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

function lancer(fichiers, request, mode = 'scan') {
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
        LKM_B64: Buffer.from(JSON.stringify(normalizeRequest(request))).toString('base64'),
      },
    });
    assert.equal(res.status, 0, res.stderr);
    const site = JSON.parse(res.stdout).sites[0];
    // Les fichiers sont relus AVANT le ménage : le dossier n'existe plus au retour.
    const apres = {};
    for (const rel of [...Object.keys(fichiers), 'sport/index.php']) {
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

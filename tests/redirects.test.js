import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HTACCESS_REDIRECTS } from '../src/services/phpScripts.js';
import { ligne, normalizeRequest, urlValide } from '../src/services/redirectService.js';

test('redirections : la ligne écrite est celle demandée', () => {
  assert.equal(
    ligne({ from: '/cystite-comprendre-les-causes.php', to: '/cystite-comprendre-les-causes' }),
    'Redirect 301 /cystite-comprendre-les-causes.php /cystite-comprendre-les-causes',
  );
});

test('redirections : ce qu’une adresse a le droit d’être', () => {
  assert.equal(urlValide('/page.php'), true);
  assert.equal(urlValide('/actu/sous/page-2.php'), true);
  assert.equal(urlValide('/'), true);

  // Un saut de ligne laisserait écrire n'importe quelle directive Apache : c'est la
  // seule injection possible par cette fonctionnalité, et elle est fermée ici.
  assert.equal(urlValide('/page.php\nRewriteEngine Off'), false);
  assert.equal(urlValide('/page.php\r\nHeader set X: y'), false);
  assert.equal(urlValide('/page.php\tautre'), false);
  assert.equal(urlValide('/page avec espace.php'), false);
  assert.equal(urlValide('/page".php'), false);

  // Une source doit désigner un chemin de CE site ; une destination peut partir ailleurs.
  assert.equal(urlValide('https://ailleurs.example/x'), false);
  assert.equal(urlValide('https://ailleurs.example/x', { destination: true }), true);
  assert.equal(urlValide('page.php', { destination: true }), false);
  assert.equal(urlValide('javascript:alert(1)', { destination: true }), false);

  assert.equal(urlValide(''), false);
  assert.equal(urlValide(null), false);
  assert.equal(urlValide(`/${'a'.repeat(600)}`), false);
});

test('redirections : la demande est nettoyée avant d’atteindre le serveur', () => {
  const out = normalizeRequest({
    'EXEMPLE.com ': { md5: 'abc', rules: [{ from: ' /a.php ', to: ' /a ' }, { from: '/a.php', to: '/autre' }, { from: '', to: '/b' }] },
    'vide.com': { rules: [] },
  });
  // Le domaine est normalisé, les blancs tombent…
  assert.deepEqual(Object.keys(out), ['exemple.com']);
  // …une même source deux fois ne garde que la première : la seconde ne veut rien dire.
  assert.deepEqual(out['exemple.com'].rules, [{ from: '/a.php', to: '/a' }]);
  assert.equal(out['exemple.com'].md5, 'abc');

  // Une liste nue reste acceptée, sans somme de contrôle.
  const nue = normalizeRequest({ 'x.com': [{ from: '/a', to: '/b' }] });
  assert.deepEqual(nue['x.com'], { md5: '', rules: [{ from: '/a', to: '/b' }] });
});

// ── Le script serveur, exécuté par PHP ─────────────────────────────────────
const php = spawnSync('php', ['-v'], { encoding: 'utf8' });
const phpAbsent = php.status !== 0;

const REPERE = '# Direct access to .php files redirects 301 to the old URL.';
const HTACCESS = [
  'RewriteEngine On',
  'ErrorDocument 404 /404.php',
  '',
  '# ── WordPress imported articles ──',
  REPERE,
  '',
  '# Block direct .php access (redirect to old permalink)',
  'RewriteCond %{ENV:REDIRECT_STATUS} ^$',
  'RewriteRule ^actu/un\\-article\\.php$ /589/un-article [R=301,L]',
  '',
  '# Catch non-existent .php files before PHP-FPM',
  'RewriteCond %{REQUEST_FILENAME} !-f',
  'RewriteRule ^.*\\.php$ /404.php [L]',
  '',
].join('\n');

/** Lance le script sur un site jetable et rend le résultat ET le fichier obtenu. */
function lancer(contenu, request, mode = 'scan', op = 'add') {
  const root = mkdtempSync(join(tmpdir(), 'lkm-red-'));
  const doc = join(root, 'exemple.com', 'public_html');
  try {
    mkdirSync(doc, { recursive: true });
    if (contenu !== null) writeFileSync(join(doc, '.htaccess'), contenu, 'utf8');
    const res = spawnSync('php', [], {
      input: HTACCESS_REDIRECTS,
      encoding: 'utf8',
      env: {
        ...process.env,
        LKM_ROOT: root,
        LKM_MODE: mode,
        LKM_OP: op,
        LKM_B64: Buffer.from(JSON.stringify(normalizeRequest(request))).toString('base64'),
      },
    });
    assert.equal(res.status, 0, res.stderr);
    const site = JSON.parse(res.stdout).sites[0];
    // Le fichier est relu AVANT le ménage : le dossier n'existe plus au retour.
    try {
      site.fichier = readFileSync(join(doc, '.htaccess'), 'utf8');
    } catch {
      site.fichier = null;
    }
    return site;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const UNE = { 'exemple.com': { rules: [{ from: '/vieille.php', to: '/nouvelle' }] } };

test('redirections : la vérification n’écrit rien', { skip: phpAbsent && 'php absent' }, () => {
  const site = lancer(HTACCESS, UNE);
  assert.equal(site.error, undefined);
  assert.equal(site.markerAt, 5);
  assert.equal(site.items[0].state, 'to_add');
  assert.deepEqual(site.existing, []);
  assert.equal(site.fichier, HTACCESS); // intact, à l'octet près
});

test('redirections : la règle atterrit juste après la ligne de repère', { skip: phpAbsent && 'php absent' }, () => {
  const site = lancer(HTACCESS, UNE, 'apply');
  const lignes = site.fichier.split('\n');
  const iRepere = lignes.indexOf(REPERE);

  // Ce qui suit le repère : le bloc du back-office, et rien d'autre avant lui. La
  // ligne vide qui suivait déjà le repère est réutilisée, on n'en ajoute pas une
  // seconde — sans quoi chaque cycle poser/retirer en laisserait une de plus.
  assert.equal(lignes[iRepere + 1], '# >>> LKM-BO redirections 301');
  assert.equal(lignes[iRepere + 2], 'Redirect 301 /vieille.php /nouvelle');
  assert.equal(lignes[iRepere + 3], '# <<< LKM-BO redirections 301');

  // Et le reste du fichier est conservé, ligne pour ligne.
  const sansBloc = lignes.filter((l, i) => i <= iRepere || i > iRepere + 3);
  assert.deepEqual(sansBloc, HTACCESS.split('\n'));
  assert.deepEqual(site.existing, [{ from: '/vieille.php', to: '/nouvelle' }]);
  assert.ok(site.stamp);
});

test('redirections : rejouée, la demande ne touche plus au fichier', { skip: phpAbsent && 'php absent' }, () => {
  const pose = lancer(HTACCESS, UNE, 'apply');
  const rejoue = lancer(pose.fichier, UNE, 'apply');
  assert.equal(rejoue.items[0].state, 'present');
  assert.deepEqual(rejoue.items[0].done, []);
  assert.equal(rejoue.fichier, pose.fichier);
});

test('redirections : changer la destination remplace la ligne, sans la dupliquer', { skip: phpAbsent && 'php absent' }, () => {
  const pose = lancer(HTACCESS, UNE, 'apply');
  const change = lancer(pose.fichier, { 'exemple.com': { rules: [{ from: '/vieille.php', to: '/autre-cible' }] } }, 'apply');
  assert.equal(change.items[0].state, 'conflict');
  assert.equal(change.items[0].current, '/nouvelle');
  assert.deepEqual(change.existing, [{ from: '/vieille.php', to: '/autre-cible' }]);
  assert.equal((change.fichier.match(/^Redirect 301 /gm) ?? []).length, 1);
});

test('redirections : poser puis retirer rend le fichier d’origine', { skip: phpAbsent && 'php absent' }, () => {
  let contenu = HTACCESS;
  // Cinq cycles : une ligne vide qui s'accumulerait se verrait tout de suite.
  for (let i = 0; i < 5; i += 1) {
    contenu = lancer(contenu, UNE, 'apply').fichier;
    contenu = lancer(contenu, { 'exemple.com': { rules: [{ from: '/vieille.php', to: '' }] } }, 'apply', 'remove').fichier;
  }
  assert.equal(contenu, HTACCESS);
});

test('redirections : ce qui empêche d’écrire est nommé, jamais deviné', { skip: phpAbsent && 'php absent' }, () => {
  // Pas de fichier du tout.
  assert.equal(lancer(null, UNE).error, 'no_htaccess');

  // La ligne de repère manque : on ne choisit pas un autre endroit à sa place.
  const sansRepere = HTACCESS.split('\n').filter((l) => l !== REPERE).join('\n');
  const a = lancer(sansRepere, UNE, 'apply');
  assert.equal(a.error, 'no_marker');
  assert.equal(a.fichier, sansRepere); // rien n'a été écrit

  // Deux repères : deux endroits possibles, donc aucun.
  const b = lancer(`${HTACCESS}\n${REPERE}\n`, UNE, 'apply');
  assert.equal(b.error, 'many_markers');

  // Un bloc ouvert sans fin : on n'invente pas où il s'arrête.
  const casse = HTACCESS.replace(REPERE, `${REPERE}\n# >>> LKM-BO redirections 301\nRedirect 301 /a /b`);
  assert.equal(lancer(casse, UNE, 'apply').error, 'block_broken');

  // Le fichier a bougé depuis la vérification.
  const bouge = lancer(HTACCESS, { 'exemple.com': { md5: 'sommequinevapas', rules: [{ from: '/a.php', to: '/b' }] } }, 'apply');
  assert.equal(bouge.error, 'changed');
  assert.equal(bouge.fichier, HTACCESS);
});

test('redirections : les règles posées ailleurs dans le fichier sont comptées, pas touchées', { skip: phpAbsent && 'php absent' }, () => {
  const avec = HTACCESS.replace('RewriteEngine On', 'RewriteEngine On\nRedirect 301 /ancienne-a-la-main.php /ailleurs');
  const site = lancer(avec, UNE, 'apply');
  assert.equal(site.foreign, 1);
  // Elle n'entre pas dans le tableau du back-office…
  assert.deepEqual(site.existing, [{ from: '/vieille.php', to: '/nouvelle' }]);
  // …et elle est toujours dans le fichier.
  assert.ok(site.fichier.includes('Redirect 301 /ancienne-a-la-main.php /ailleurs'));
});

test('redirections : une adresse refusée n’écrit rien et se dit refusée', { skip: phpAbsent && 'php absent' }, () => {
  // Le script PHP revérifie ce que le service a déjà refusé : trois barrages valent
  // mieux qu'un, sur un fichier qui porte tout le routage du site.
  const site = lancer(HTACCESS, { 'exemple.com': { rules: [{ from: '/a.php\nRewriteEngine Off', to: '/b' }] } }, 'apply');
  assert.equal(site.items[0].state, 'invalid');
  assert.equal(site.fichier, HTACCESS);
  assert.ok(!site.fichier.includes('RewriteEngine Off'));
});

test('redirections : les fins de ligne du fichier sont conservées', { skip: phpAbsent && 'php absent' }, () => {
  const crlf = HTACCESS.replace(/\n/g, '\r\n');
  const site = lancer(crlf, UNE, 'apply');
  assert.ok(site.fichier.includes('\r\n'));
  // Aucun \n solitaire : on n'a pas mélangé les deux conventions.
  assert.equal((site.fichier.match(/(?<!\r)\n/g) ?? []).length, 0);
});

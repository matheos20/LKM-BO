import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  A_REDIRIGER,
  AWK,
  MAX_CHEMINS,
  ORDRE,
  UrlCheckService,
  cheminValide,
  normalizePaths,
  parseProbe,
  probeCommand,
  resume,
  verdict,
} from '../src/services/urlCheckService.js';
import { CHARGE_PLAFOND, PRESSION_MAX, ServerLoad } from '../src/services/serverLoad.js';

/**
 * Le scanner 404, et le frein qu'il partage avec la santé du parc.
 *
 * DEUX MESURES DU 05/10/2026 ONT FAÇONNÉ CE SERVICE :
 *
 *   1. une adresse en « .php » absente rend bien 404 — mais UNE ADRESSE SANS EXTENSION
 *      REND 200, avec la page d'accueil. Vérifié sur onze sites de deux serveurs. C'est
 *      le pire cas : ni le visiteur ni Google ne voient d'erreur, et personne ne trouve
 *      la page. Un scanner qui ne le démasque pas déclare saines des adresses mortes ;
 *   2. le lien canonique NE PERMET PAS de le démasquer : le moteur y recopie le chemin
 *      demandé. C'est le titre qui distingue — celui de l'accueil quand la page est
 *      absente, « page not found » sur un vrai 404.
 *
 * Et une troisième, qui a changé le frein : vps-003 affichait 182 de charge avec 234
 * processus bloqués sur le disque et UN SEUL en calcul. Ces machines manquent de disque,
 * pas de processeur — d'où la seconde barrière, sur `/proc/pressure/io`.
 */
const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Un faux parc : aucune connexion, et un journal de ce qui a été demandé. */
function fauxSsh({ charge = '1.0\n8\n0', lignes = [] } = {}) {
  const vues = [];
  return {
    vues,
    server: () => ({ id: 'vps-004', label: 'VPS 004', wwwRoot: '/srv/www' }),
    exec: async (id, cmd) => {
      vues.push(cmd);
      if (cmd.includes('/proc/loadavg')) return { stdout: typeof charge === 'function' ? charge(vues.length) : charge };
      const rendu = typeof lignes === 'function' ? lignes(cmd) : lignes;
      return { stdout: rendu.map((l) => (Array.isArray(l) ? l.join('\t') : l)).join('\n') };
    },
  };
}

/** Une ligne de sonde : domaine, chemin, code, durée, poids, renvoi, erreurs PHP, titre. */
const sonde = (domain, path, code, opts = {}) => [
  domain,
  path,
  String(code),
  String(opts.time ?? 0.1),
  String(opts.bytes ?? 16000),
  opts.redirect ?? '',
  String(opts.errors ?? 0),
  opts.title ?? '',
];

const service = (opts) => new UrlCheckService(fauxSsh(opts));

// ─────────────────────────── ce que l'agent colle ───────────────────────────

test('404 : une adresse complète est ramenée à son chemin', () => {
  // L'agent colle ce qu'il a sous la main, et ce qu'il a vient de la Search Console :
  // des adresses complètes. C'est la sélection de domaines qui décide où tester.
  const { paths } = normalizePaths('https://exemple.fr/ancienne.php\nhttp://autre.com/vieille.php');
  assert.deepEqual(paths, ['/ancienne.php', '/vieille.php']);
});

test('404 : une barre oblique manquante est ajoutée, un ancrage est retiré', () => {
  // « page.php » sans barre est ce qu'on recopie d'un tableau ; l'ancrage, lui, ne voyage
  // jamais jusqu'au serveur — le garder ferait tester une adresse qui n'existe pas.
  const { paths } = normalizePaths('page.php\n/autre.php#section');
  assert.deepEqual(paths, ['/page.php', '/autre.php']);
});

test('404 : les doublons et les lignes vides disparaissent', () => {
  const { paths } = normalizePaths('/a.php\n\n/a.php\nhttps://x.fr/a.php\n  \n/b.php');
  assert.deepEqual(paths, ['/a.php', '/b.php']);
});

test('404 : une adresse complète sans chemin devient la racine', () => {
  assert.deepEqual(normalizePaths('https://exemple.fr').paths, ['/']);
  assert.deepEqual(normalizePaths('https://exemple.fr/').paths, ['/']);
});

test('404 : une adresse impossible est REFUSÉE, et l’agent le voit', () => {
  // Taire une ligne refusée serait pire que la refuser : l'agent croirait son adresse
  // testée, et conclurait qu'elle va bien.
  const { paths, rejected } = normalizePaths('/bon.php\n/chemin avec espace.php\n/avec"guillemet.php');
  assert.deepEqual(paths, ['/bon.php']);
  assert.equal(rejected.length, 2);
  assert.ok(rejected[0].includes('espace'));
});

test('404 : la liste est plafonnée', () => {
  const brut = Array.from({ length: MAX_CHEMINS + 20 }, (_, i) => `/p${i}.php`).join('\n');
  assert.equal(normalizePaths(brut).paths.length, MAX_CHEMINS);
  assert.equal(normalizePaths('/a.php\n/b.php\n/c.php', { max: 2 }).paths.length, 2);
});

test('404 : un chemin doit commencer par une barre et ne porter aucun blanc', () => {
  assert.ok(cheminValide('/a.php'));
  assert.ok(cheminValide('/dossier/sous/a.php?x=1'));
  assert.ok(!cheminValide('a.php'));
  assert.ok(!cheminValide('/a b.php'));
  assert.ok(!cheminValide("/a'b.php"));
  assert.ok(!cheminValide('/a\nb.php'));
  assert.ok(!cheminValide(`/${'x'.repeat(1030)}`));
});

// ─────────────────────────── la commande envoyée ───────────────────────────

test('404 : ni le domaine ni le chemin ne sont recopiés dans la commande', () => {
  // Les deux finissent dans une requête composée par un shell : ils arrivent donc en
  // paramètres, « $1 » et « $2 ». C'est cela qui ferme l'injection, pas la validation.
  const cmd = probeCommand([{ domain: 'exemple.fr', path: '/a.php' }]);
  assert.match(cmd, /-H "Host: \$1"/);
  assert.match(cmd, /127\.0\.0\.1:8080\$2/);
  assert.ok(!/Host: exemple\.fr/.test(cmd));
  assert.ok(!cmd.includes('8080/a.php'));
  // Deux valeurs par appel : le domaine, puis le chemin.
  assert.match(cmd, /xargs -P \d+ -n 2 bash -c/);
});

test('404 : un chemin hostile ressort entre quotes, inoffensif', () => {
  const cmd = probeCommand([{ domain: 'exemple.fr', path: "/a.php'; rm -rf / #" }]);
  assert.match(cmd, /'\/a\.php'\\''; rm -rf \/ #'/);
  assert.ok(!/\n *rm -rf/.test(cmd));
});

test('404 : la commande n’écrit rien', () => {
  const cmd = probeCommand([{ domain: 'a.fr', path: '/b.php' }]);
  for (const interdit of [/\bmkdir\b/, /\bchmod\b/, /\btee\b/, /\brm\b/, /\bcp\b/, /\bmv\b/]) {
    assert.ok(!interdit.test(cmd), `interdit : ${interdit}`);
  }
  for (const [, cible] of cmd.matchAll(/(?:^|\s)\d?>\s*(\S+)/g)) assert.equal(cible, '/dev/null');
});

test('404 : le titre est lu, car c’est lui qui démasque un faux 404', () => {
  assert.match(AWK, /<title>/);
  // Une tabulation dans un titre casserait le découpage des champs.
  assert.match(AWK, /gsub\(\/\[\\t\\r\]\/, " ", titre\)/);
  // Et il est tronqué : certains titres font des centaines de caractères, fois 28 177.
  assert.match(AWK, /substr\(titre, 1, 160\)/);
});

// ─────────────────────────── la lecture ───────────────────────────

test('404 : une ligne se relit, une ligne tronquée est ignorée', () => {
  const lu = parseProbe(['a.fr\t/x.php\t404\t0.05\t16101\t\t0\tpage not found — a', 'tronquee\t/y.php\t404', ''].join('\n'));
  assert.equal(lu.length, 1);
  assert.deepEqual(lu[0], {
    domain: 'a.fr',
    path: '/x.php',
    code: 404,
    time: 0.05,
    bytes: 16101,
    redirect: null,
    phpErrors: 0,
    title: 'page not found — a',
  });
});

// ─────────────────────────── le verdict ───────────────────────────

test('404 : chaque état vient de ce qui a été mesuré', () => {
  const accueil = { title: 'exemple - accueil' };
  const v = (row) => verdict({ domain: 'exemple.fr', path: '/x.php', redirect: null, phpErrors: 0, bytes: 16000, title: 'x - exemple', ...row }, accueil);
  assert.equal(v({ code: 404 }), 'missing');
  assert.equal(v({ code: 410 }), 'missing', 'une page explicitement retirée est morte aussi');
  assert.equal(v({ code: 0 }), 'unreachable');
  assert.equal(v({ code: 500 }), 'server_error');
  assert.equal(v({ code: 403 }), 'refused');
  assert.equal(v({ code: 301, redirect: 'https://exemple.fr/neuve.php' }), 'redirect');
  assert.equal(v({ code: 200, phpErrors: 2 }), 'php_error');
  assert.equal(v({ code: 200 }), 'ok');
});

test('404 : LE FAUX 404 est démasqué par le titre de l’accueil', () => {
  // Mesuré : `/lkm-absent-sans-extension` rend 200 avec 40 à 64 ko — la page d'accueil — et
  // son titre. Sans cette comparaison, l'adresse passerait pour saine.
  const accueil = { title: 'carfanaticszone - the vehicle' };
  const faux = { domain: 'carfanaticszone.com', path: '/vieux/page-retiree', code: 200, bytes: 29050, redirect: null, phpErrors: 0, title: 'carfanaticszone - the vehicle' };
  assert.equal(verdict(faux, accueil), 'soft_missing');
  // Une vraie page porte son propre titre.
  assert.equal(verdict({ ...faux, path: '/contact.php', title: 'contact - carfanaticszone' }, accueil), 'ok');
});

test('404 : l’accueil lui-même n’est JAMAIS un faux 404, sous AUCUN de ses noms', () => {
  // `/index.php` EST l'accueil : nginx le sert pour « / ». Il a donc le titre de l'accueil,
  // et la première version le condamnait — vérifié sur cinq sites de vps-004, il
  // ressortait « page absente » alors qu'il va parfaitement bien.
  const accueil = { title: 'exemple - accueil' };
  const page = (path) => ({ domain: 'exemple.fr', path, code: 200, bytes: 50000, redirect: null, phpErrors: 0, title: 'exemple - accueil' });
  assert.equal(verdict(page('/'), accueil), 'ok');
  assert.equal(verdict(page('/index.php'), accueil), 'ok');
  // Mais une AUTRE adresse qui reçoit l'accueil reste un faux 404.
  assert.equal(verdict(page('/ancien-catalogue/produit-retire'), accueil), 'soft_missing');
});

test('404 : sans référence d’accueil, on ne DEVINE pas un faux 404', () => {
  // Mieux vaut dire « en ordre » que d'accuser au hasard : un faux positif ferait poser
  // une redirection sur une page qui existe.
  const row = { domain: 'a.fr', path: '/x', code: 200, bytes: 50000, redirect: null, phpErrors: 0, title: 'a - accueil' };
  assert.equal(verdict(row, null), 'ok');
  assert.equal(verdict(row, { title: null }), 'ok');
  assert.equal(verdict({ ...row, title: null }, { title: 'a - accueil' }), 'ok');
});

test('404 : une page en panne reste en panne, même si son titre ressemble', () => {
  const accueil = { title: 'a - accueil' };
  assert.equal(verdict({ domain: 'a.fr', path: '/x', code: 500, bytes: 0, redirect: null, phpErrors: 0, title: 'a - accueil' }, accueil), 'server_error');
});

test('404 : ce qui mérite une redirection, et dans quel ordre on le montre', () => {
  // Les deux formes de mort, et elles seules : une adresse déjà redirigée ne doit surtout
  // pas en recevoir une seconde par-dessus.
  assert.deepEqual(A_REDIRIGER, ['missing', 'soft_missing']);
  assert.equal(ORDRE[0], 'missing');
  assert.equal(ORDRE[1], 'soft_missing');
  assert.equal(ORDRE.at(-1), 'ok', 'ce qui va bien se lit en dernier');
  for (const etat of A_REDIRIGER) assert.ok(ORDRE.includes(etat));
});

test('404 : le résumé compte les sites autant que les adresses', () => {
  // « Douze adresses mortes » ne dit pas la même chose sur un site que sur douze.
  const r = resume([
    { state: 'missing', domain: 'a.fr' },
    { state: 'missing', domain: 'b.fr' },
    { state: 'soft_missing', domain: 'a.fr' },
    { state: 'ok', domain: 'a.fr' },
  ]);
  assert.deepEqual(r, { total: 4, ok: 1, missing: 3, domains: 2, byState: { missing: 2, soft_missing: 1, ok: 1 } });
  assert.deepEqual(resume([]), { total: 0, ok: 0, missing: 0, domains: 0, byState: {} });
});

// ─────────────────────────── le scan, de bout en bout ───────────────────────────

test('404 : l’accueil est sondé en PREMIER, sur chaque domaine', async () => {
  const ssh = fauxSsh({ lignes: [sonde('a.fr', '/', 200, { title: 'a - accueil', bytes: 50000 }), sonde('a.fr', '/x.php', 404)] });
  const out = await new UrlCheckService(ssh).check('vps-004', ['a.fr'], ['/x.php'], { rate: 1e6 });
  const cmd = ssh.vues.find((c) => c.includes('curl'));
  // L'accueil doit être DANS le même lot : une seconde visite au serveur coûterait un
  // aller-retour par domaine pour un renseignement qu'on peut avoir du premier coup.
  assert.match(cmd, /'a\.fr' '\/' 'a\.fr' '\/x\.php'/);
  assert.equal(out.urls.length, 1, 'et il ne figure pas dans le résultat');
  assert.equal(out.urls[0].path, '/x.php');
});

test('404 : l’accueil figure au résultat quand l’agent l’a DEMANDÉ', async () => {
  const ssh = fauxSsh({ lignes: [sonde('a.fr', '/', 200, { title: 'a - accueil', bytes: 50000 })] });
  const out = await new UrlCheckService(ssh).check('vps-004', ['a.fr'], ['/'], { rate: 1e6 });
  assert.equal(out.urls.length, 1);
  assert.equal(out.urls[0].path, '/');
  assert.equal(out.urls[0].state, 'ok');
});

test('404 : chaque adresse est testée sur chaque domaine', async () => {
  const ssh = fauxSsh({
    lignes: [
      sonde('a.fr', '/', 200, { title: 'a', bytes: 50000 }),
      sonde('b.fr', '/', 200, { title: 'b', bytes: 50000 }),
      sonde('a.fr', '/x.php', 404),
      sonde('b.fr', '/x.php', 200, { title: 'x - b' }),
      sonde('a.fr', '/y.php', 404),
      sonde('b.fr', '/y.php', 404),
    ],
  });
  const out = await new UrlCheckService(ssh).check('vps-004', ['a.fr', 'b.fr'], ['/x.php', '/y.php'], { rate: 1e6 });
  assert.equal(out.summary.total, 4);
  assert.equal(out.summary.missing, 3);
  assert.equal(out.summary.ok, 1);
  assert.equal(out.summary.domains, 2);
});

test('404 : AUCUN accueil n’ayant répondu, aucune adresse n’est déclarée morte', async () => {
  // Sans ce garde-fou, une sonde en panne — mauvais port, serveur web arrêté — ferait
  // déclarer mortes toutes les adresses de tous les sites.
  const ssh = fauxSsh({ lignes: [] });
  await assert.rejects(
    () => new UrlCheckService(ssh).check('vps-004', ['a.fr'], ['/x.php'], { rate: 1e6 }),
    (e) => e.key === 'errors.health_probe_unreachable',
  );
});

test('404 : une sonde dont la ligne manque n’est pas « en ordre »', async () => {
  const ssh = fauxSsh({ lignes: [sonde('a.fr', '/', 200, { title: 'a', bytes: 50000 }), sonde('a.fr', '/vu.php', 404)] });
  const out = await new UrlCheckService(ssh).check('vps-004', ['a.fr'], ['/vu.php', '/perdu.php'], { rate: 1e6 });
  const etats = Object.fromEntries(out.urls.map((u) => [u.path, u.state]));
  assert.equal(etats['/vu.php'], 'missing');
  assert.equal(etats['/perdu.php'], 'no_answer');
  assert.equal(out.summary.ok, 0);
});

test('404 : un domaine qui n’en est pas un, ou aucune adresse : on le dit', async () => {
  const ssh = fauxSsh();
  await assert.rejects(() => new UrlCheckService(ssh).check('vps-004', ['pas un domaine'], ['/a.php']), (e) => e.key === 'errors.health_no_target');
  await assert.rejects(() => new UrlCheckService(ssh).check('vps-004', ['a.fr'], []), (e) => e.key === 'errors.urls_none');
  await assert.rejects(() => new UrlCheckService(ssh).check('vps-004', ['a.fr'], ['pas-un-chemin']), (e) => e.key === 'errors.urls_none');
  assert.equal(ssh.vues.length, 0, 'et rien n’est demandé au serveur');
});

test('404 : le frein se compte en DOMAINES, pas en requêtes', async () => {
  // Mesuré le 05/10/2026 : une adresse de plus sur un site déjà visité coûte 0,029 s,
  // un site neuf 0,050 s sur une machine saine — et 0,004 s contre 4,4 s sur une machine
  // saturée. C'est le premier contact avec un site qui coûte.
  const lignes = [];
  for (const d of ['a.fr', 'b.fr']) {
    lignes.push(sonde(d, '/', 200, { title: d, bytes: 50000 }));
    for (let i = 0; i < 10; i++) lignes.push(sonde(d, `/p${i}.php`, 404));
  }
  const ssh = fauxSsh({ lignes });
  const t = Date.now();
  const out = await new UrlCheckService(ssh).check('vps-004', ['a.fr', 'b.fr'], Array.from({ length: 10 }, (_, i) => `/p${i}.php`), { rate: 10 });
  const ecoule = Date.now() - t;
  assert.equal(out.summary.total, 20, '20 requêtes…');
  // …mais le frein ne retient que pour 2 domaines à 10/s, soit 200 ms. S'il comptait les
  // requêtes, il aurait attendu 2 secondes.
  assert.ok(ecoule >= 180, `le frein doit retenir (${ecoule} ms)`);
  assert.ok(ecoule < 1500, `mais sur les domaines, pas sur les requêtes (${ecoule} ms)`);
});

// ─────────────────────────── le frein partagé ───────────────────────────

test('frein : la pression DISQUE arrête l’analyse, même à charge normale', async () => {
  // Le 05/10/2026, vps-003 affichait 234 processus bloqués sur le disque et UN SEUL en
  // calcul : 15 % de pression CPU, 99,8 % de pression I/O. Une barrière sur la seule
  // charge aurait pu laisser passer ; sur ces machines, c'est le disque qui manque.
  const ssh = fauxSsh({ charge: '1.0\n8\n99.6' });
  await assert.rejects(
    () => new UrlCheckService(ssh).check('vps-004', ['a.fr'], ['/x.php'], { maxWait: 0, rate: 1e6 }),
    (e) => e.key === 'errors.health_server_io' && e.vars.io === '100',
  );
  assert.ok(!ssh.vues.some((c) => c.includes('curl')), 'aucune sonde n’a été lancée');
});

test('frein : une machine sans /proc/pressure n’est pas bloquée pour autant', async () => {
  // On ne refuse pas de travailler faute de thermomètre : la charge reste là pour trancher.
  const ssh = fauxSsh({ charge: '1.0\n8\n0', lignes: [sonde('a.fr', '/', 200, { title: 'a', bytes: 50000 }), sonde('a.fr', '/x.php', 404)] });
  const out = await new UrlCheckService(ssh).check('vps-004', ['a.fr'], ['/x.php'], { rate: 1e6 });
  assert.equal(out.urls[0].state, 'missing');
  assert.equal(out.load.io, 0);
});

test('frein : une crise au premier contact ne devient pas la « référence » de la machine', async () => {
  // Sans plafond absolu, vps-003 à 22,8 par cœur deviendrait son habitude, et l'analyse
  // s'autoriserait 23,6 — c'est-à-dire tout.
  const load = new ServerLoad(fauxSsh({ charge: '182.6\n8\n0' }).exec ? fauxSsh({ charge: '182.6\n8\n0' }) : null);
  await assert.rejects(
    () => load.attendre('vps-004', { attenteMax: 0 }),
    (e) => e.key === 'errors.health_server_busy',
  );
  assert.equal(CHARGE_PLAFOND, 4);
  assert.ok(load.repos.get('vps-004') > CHARGE_PLAFOND, 'la référence est bien prise…');
  assert.equal(load.plafond('vps-004'), CHARGE_PLAFOND, '…mais le plafond la borne');
});

test('frein : le même frein sert les deux analyses', async () => {
  // Deux exemplaires apprendraient deux fois le train de vie de chaque machine, et la
  // première analyse de la journée se tromperait de référence.
  const serveur = readFileSync(join(RACINE, 'src/server.js'), 'utf8');
  assert.match(serveur, /const serverLoad = new ServerLoad\(ssh\);/);
  assert.match(serveur, /new HealthService\(ssh, serverLoad\)/);
  assert.match(serveur, /new UrlCheckService\(ssh, serverLoad\)/);
});

// ─────────────────────────── le traitement et l'écran ───────────────────────────

test('404 : le traitement est une ANALYSE, et exige le droit d’analyse', async () => {
  const { buildJobKinds } = await import('../src/services/jobKinds.js');
  const kinds = buildJobKinds({ translation: {}, categories: {}, redirects: {}, cloudflare: {}, health: {}, urls: {} });
  const kind = kinds['urls.scan'];
  assert.ok(kind, 'le traitement doit être au catalogue');
  assert.equal(kind.permission, 'bulk.read', 'rien n’est écrit');
  assert.equal(kind.perServer, true);
  // Le lot se MULTIPLIE par le nombre d'adresses : vingt domaines fois cinquante adresses
  // font déjà mille requêtes dans un seul lot.
  assert.ok(kind.batch <= 20, `lot trop gros : ${kind.batch}`);
});

test('404 : l’écran est branché, après la santé du parc', () => {
  const actions = readFileSync(join(RACINE, 'public/js/actions.js'), 'utf8');
  assert.match(actions, /import \{ urlAction \} from '\.\/urls\.js';/);
  assert.match(actions, /const ACTIONS = \[healthAction, urlAction,/);
});

test('404 : le raccourci 301 remplit la redirection, DESTINATION VIDE', () => {
  // C'est à l'agent de décider où envoyer le visiteur : personne d'autre ne peut le
  // savoir, et une destination devinée serait pire qu'une case vide.
  const redirects = readFileSync(join(RACINE, 'public/js/redirects.js'), 'utf8');
  assert.match(redirects, /export function prefillRedirects/);
  assert.match(redirects, /\.map\(\(from\) => \(\{ from, to: '' \}\)\)/);
  // Et l'opération revient à « ajouter » : on arrive ici pour poser, pas pour retirer.
  assert.match(redirects, /state\.operation = 'add';/);

  const actions = readFileSync(join(RACINE, 'public/js/actions.js'), 'utf8');
  assert.match(actions, /async function versRedirection/);
  // Le périmètre devient la liste des sites concernés, et non tout le serveur.
  assert.match(actions, /state\.scope = 'list';/);
  assert.match(actions, /majZoneListe\(\)/, 'le champ doit être rafraîchi, sinon il reste vide à l’écran');
});

test('404 : seules les adresses en « .php » partent vers la redirection', () => {
  // Le mécanisme pose un petit fichier à l'ancienne adresse ; nginx servirait en clair un
  // fichier sans extension. L'écran le dit au lieu d'échouer plus loin.
  const ecran = readFileSync(join(RACINE, 'public/js/urls.js'), 'utf8');
  assert.match(ecran, /endsWith\('\.php'\)/);
  assert.match(ecran, /urls\.not_redirectable/);
  assert.match(ecran, /disabled: !redirigeables\.length/);
});

test('404 : tous les états ont un libellé dans les six langues', () => {
  const etats = [...ORDRE];
  for (const langue of ['fr', 'en', 'es', 'it', 'pt', 'de']) {
    const textes = JSON.parse(readFileSync(join(RACINE, 'locales', `${langue}.json`), 'utf8'));
    assert.equal(typeof textes.actions?.urls, 'string', `${langue} : « actions.urls » manque`);
    for (const etat of etats) {
      const libelle = textes.urls?.[`state_${etat}`];
      assert.equal(typeof libelle, 'string', `${langue} : « urls.state_${etat} » manque`);
      assert.ok(libelle.trim().length > 0);
    }
    for (const cle of [
      'explain', 'step_what', 'step_what_hint', 'kept', 'rejected', 'paste_hint',
      'stat_checked', 'stat_dead', 'stat_alive', 'stat_sites',
      'col_path', 'col_code', 'col_size',
      'none_dead', 'nothing_measured', 'dead_count', 'not_redirectable', 'not_redirectable_hint',
      'to_redirect', 'handed_over', 'busy_note', 'soft_missing_hint',
    ]) {
      assert.equal(typeof textes.urls?.[cle], 'string', `${langue} : « urls.${cle} » manque`);
      assert.ok(textes.urls[cle].trim().length > 3);
    }
    for (const cle of ['urls_none', 'health_server_io']) {
      assert.equal(typeof textes.errors?.[cle], 'string', `${langue} : « errors.${cle} » manque`);
    }
  }
});

test('404 : les messages nomment leurs variables, et le faux 404 est EXPLIQUÉ', () => {
  const { urls, errors } = JSON.parse(readFileSync(join(RACINE, 'locales/fr.json'), 'utf8'));
  assert.match(urls.dead_count, /\{count\}.*\{sites\}/);
  assert.match(urls.not_redirectable, /\{count\}/);
  assert.match(urls.handed_over, /\{count\}.*\{sites\}/);
  assert.match(urls.busy_note, /\{server\}.*\{io\}/);
  assert.match(errors.health_server_io, /\{server\}.*\{io\}/);
  // Le libellé seul ne suffit pas : « page absente, serveur muet » demande une phrase.
  assert.match(urls.soft_missing_hint, /200/);
  assert.match(urls.state_soft_missing, /\S/);
  // Et la limite du « .php » doit être dite en clair, pas sous-entendue.
  assert.match(urls.not_redirectable_hint, /\.php/);
});

test('404 : le seuil de pression disque reste celui qui a été mesuré', () => {
  // 0,02 à 4 % sur les quatre machines saines, 99,6 % sur celle qui souffrait : la
  // séparation est franche, et c'est pourquoi le seuil peut être généreux.
  assert.equal(PRESSION_MAX, 50);
});

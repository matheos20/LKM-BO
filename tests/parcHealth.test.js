import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  AWK,
  CHARGE_MAX,
  HealthService,
  MARGE_CHARGE,
  PORT_DEFAUT,
  SEUIL_LENT,
  SEUIL_VIDE,
  TEMOIN,
  parseProbe,
  parseTouch,
  probeCommand,
  protocole,
  renvoiInterne,
  resume,
  touchCommand,
  verdict,
} from '../src/services/healthService.js';

/**
 * La santé du parc : ce qui a été mesuré, et ce qu'il ne faut plus réapprendre.
 *
 * TROIS MESURES DU 02/10/2026 ONT FAÇONNÉ CE SERVICE, et chacune a coûté quelque chose :
 *
 *   1. une analyse de 300 sites à dix sondes en parallèle a fait passer la charge de
 *      vps-001 de 6 à 138 sur 8 cœurs, et de vrais visiteurs ont été servis en 8,8 s au
 *      lieu de 2. Le frein n'est donc pas un ornement : les tests ci-dessous vérifient
 *      qu'il est toujours là, et qu'il renonce plutôt que d'insister ;
 *   2. un port mal deviné faisait déclarer TOUS les sites en panne. Le témoin ferme
 *      cette porte : sans réponse de sa part, aucun verdict n'est rendu ;
 *   3. `imagedor.com` rend 301 vers `www.imagedor.com`, et c'est voulu. Signaler ces
 *      renvois canoniques aurait noyé les vraies pannes.
 */
const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Un faux parc : aucune connexion, et un journal de ce qui a été demandé.
 *
 * `reponses` reçoit, pour chaque commande attendue, ce que le serveur rendrait. La charge
 * est servie telle quelle ; la sonde, ligne par ligne.
 */
function fauxSsh({ charge = '1.0\n8\n0', lignes = [], retouches = [], httpPort, surRetouche } = {}) {
  const vues = [];
  return {
    vues,
    server: () => ({ id: 'vps-001', label: 'VPS 001', wwwRoot: '/srv/www', httpPort }),
    exec: async (id, cmd) => {
      vues.push(cmd);
      if (cmd.includes('/proc/loadavg')) return { stdout: typeof charge === 'function' ? charge(vues.length) : charge };
      // DEUX COMMANDES PARTENT PAR LOT, et elles ne se ressemblent pas : la sonde HTTP
      // passe par curl, la lecture des dates par find. Un faux serveur qui répondrait la
      // même chose aux deux laisserait passer une confusion entre leurs sorties.
      if (cmd.includes('LKM_ROOT')) {
        if (surRetouche) return surRetouche(cmd);
        return { stdout: retouches.map((l) => (Array.isArray(l) ? l.join('\t') : l)).join('\n') };
      }
      const rendu = typeof lignes === 'function' ? lignes(cmd) : lignes;
      return { stdout: rendu.map((l) => (Array.isArray(l) ? l.join('\t') : l)).join('\n') };
    },
  };
}

/** Une ligne de dates, telle que `find` la rend : domaine, mtime en secondes, chemin. */
const retouche = (domain, secondes, chemin) => [domain, String(secondes), chemin];

/** Une ligne de sonde, telle que le serveur la rend. */
const ligne = (domain, code, time = 0.1, bytes = 50000, redirect = '', errors = 0) => [domain, code, time, bytes, redirect, errors];

const sonde = (domain, code, opts = {}) => [
  ...ligne(domain, code, opts.time ?? 0.1, opts.bytes ?? 50000, opts.redirect ?? '', opts.errors ?? 0),
  opts.canonical ?? (code === 200 ? `https://${domain}/` : ''),
];

// ─────────────────────────── la commande envoyée ───────────────────────────

test('santé : le domaine n’est JAMAIS recopié dans le texte de la commande', () => {
  // C'est le seul endroit par où une injection pourrait passer : le domaine finit dans
  // un en-tête HTTP, composé par un shell. Il arrive donc en PARAMÈTRE (`"$1"`), et la
  // commande elle-même ne contient aucun nom de site.
  const cmd = probeCommand(['exemple.fr', 'autre.com']);
  assert.match(cmd, /-H "Host: \$1"/, 'le domaine doit venir de $1');
  assert.ok(!/Host: exemple\.fr/.test(cmd), 'et jamais être écrit dans la commande');
  assert.match(cmd, /xargs -P \d+ -n 1 bash -c/, 'un domaine par appel, passé en argument');
});

test('santé : un nom hostile ressort entre quotes, inoffensif', () => {
  const cmd = probeCommand(["exemple.fr'; rm -rf / #"]);
  // La quote POSIX referme et rouvre : la commande reste une seule chaîne.
  assert.match(cmd, /'exemple\.fr'\\''; rm -rf \/ #'/);
  assert.ok(!/\n *rm -rf/.test(cmd), 'rien ne doit devenir une commande à part entière');
});

test('santé : la sonde interroge la boucle locale, sur le port mesuré', () => {
  assert.match(probeCommand(['a.fr']), new RegExp(`http://127\\.0\\.0\\.1:${PORT_DEFAUT}/`));
  assert.match(probeCommand(['a.fr'], { port: 8099 }), /127\.0\.0\.1:8099/);
  // Rien ne sort de la machine : ni nom d'hôte public, ni https.
  assert.ok(!/https:\/\//.test(probeCommand(['a.fr'])));
});

test('santé : le dépouillement ne garde pas la page en mémoire', () => {
  // La page est lue en flux par awk. Une page de 65 ko par site, fois cinquante sites,
  // tiendrait dans une variable de shell — mais rien ne garantit qu'elle soit du texte.
  assert.match(AWK, /tolower\(\$0\)/);
  assert.match(AWK, /fatal error\|parse error/);
  // « Warning: » et « Notice: » sont volontairement absents : ces mots s'écrivent dans
  // un article sans que rien n'aille mal.
  assert.ok(!/warning/i.test(AWK), 'pas de signature qui crie au loup');
  assert.ok(!/notice/i.test(AWK));
});

// ─────────────────────────── la lecture du résultat ───────────────────────────

test('santé : une ligne de sonde se relit, une ligne tronquée est ignorée', () => {
  const lu = parseProbe(['exemple.fr\t200\t0.12\t51234\t\t0', 'tronquee.fr\t200', '', 'autre.fr\t500\t1.5\t900\t\t2'].join('\n'));
  assert.equal(lu.length, 2);
  assert.deepEqual(lu[0], { domain: 'exemple.fr', code: 200, time: 0.12, bytes: 51234, redirect: null, phpErrors: 0, canonical: null });
  assert.equal(lu[1].phpErrors, 2);
});

test('santé : les retours chariot de Windows ne faussent pas la lecture', () => {
  const lu = parseProbe('exemple.fr\t301\t0.4\t178\thttps://www.exemple.fr/\t0\r\n');
  assert.equal(lu[0].redirect, 'https://www.exemple.fr/');
});

// ─────────────────────────── http ou https ───────────────────────────

test('santé : le protocole vient de l’adresse que le site se donne, pas de la sonde', () => {
  // La sonde parle au serveur EN CLAIR sur le port 8080 : elle ne peut pas voir ce qu'un
  // visiteur obtient, puisque Cloudflare termine le TLS en amont. Ce qui est lu, c'est
  // l'adresse canonique écrite dans la page — et c'est elle qui compte pour les moteurs
  // de recherche, car c'est là que le site envoie ses visiteurs.
  assert.equal(protocole({ canonical: 'https://exemple.fr/' }), 'https');
  assert.equal(protocole({ canonical: 'http://exemple.fr/' }), 'http');
  assert.equal(protocole({ canonical: 'HTTPS://Exemple.FR/' }), 'https');
  // À défaut : la destination du renvoi. Un site canonique en « www » redirige avant de
  // servir une page — il n'y a donc aucune adresse canonique à lire. Mesuré sur
  // maxiwebshop.com, qui rend 301.
  assert.equal(protocole({ canonical: null, redirect: 'https://www.exemple.fr/' }), 'https');
  // Et quand rien ne le dit, on ne devine pas.
  assert.equal(protocole({ canonical: null, redirect: null }), null);
  assert.equal(protocole({}), null);
  assert.equal(protocole({ canonical: '/accueil' }), null);
});

test('santé : l’adresse canonique est lue dans la page DÉJÀ téléchargée', () => {
  // Une seconde requête par site aurait doublé le réveil des pools php-fpm — exactement
  // ce que les trois freins existent pour éviter.
  assert.match(AWK, /rel="\?canonical"\?/);
  assert.match(AWK, /href="\[\^"\]\+"/);
  assert.equal(probeCommand(['a.fr']).match(/curl/g).length, 1, 'une seule requête par site');
});

test('santé : la sonde rend le protocole avec le reste', () => {
  const lu = parseProbe('exemple.fr\t200\t0.1\t50000\t\t0\thttps://exemple.fr/');
  assert.equal(lu[0].canonical, 'https://exemple.fr/');
  // Une ligne sans adresse canonique reste lisible : le champ est simplement vide.
  assert.equal(parseProbe('a.fr\t200\t0.1\t50000\t\t0')[0].canonical, null);
});

// ─────────────────────────── dernière retouche ───────────────────────────

test('santé : la lecture des dates ne réveille AUCUN moteur PHP', () => {
  const cmd = touchCommand('/srv/www', ['exemple.fr']);
  assert.ok(!/curl/.test(cmd), 'aucune requête HTTP : c’est de la lecture de répertoires');
  assert.match(cmd, /find -L/, '-L parce qu’un site sur trois est un lien vers /data/www');
  assert.match(cmd, /-type f -printf/);
  // Les chemins en point sont écartés : `.lkm-backups` est notre comptabilité, pas le site,
  // et nginx refuse de les servir de toute façon.
  assert.match(cmd, /-name "\\?\.\\?\*" -prune/);
});

test('santé : ni la racine ni le domaine ne sont recopiés dans la commande', () => {
  // Même règle que pour la sonde : la racine passe par une variable, le domaine par « $1 ».
  const cmd = touchCommand('/srv/www', ["exemple.fr'; rm -rf / #"]);
  assert.match(cmd, /export LKM_ROOT='\/srv\/www'/);
  assert.match(cmd, /\$LKM_ROOT\/\$1\/public_html/);
  assert.ok(!/\n *rm -rf/.test(cmd), 'un nom hostile ne devient pas une commande');
});

test('santé : une date de retouche se lit en millisecondes absolues', () => {
  // Les serveurs vivent en UTC et l'agent trois heures devant : le serveur rend un instant,
  // l'écran le traduit. Une date déjà formatée côté serveur aurait été fausse de trois heures.
  const lu = parseTouch('exemple.fr\t1790162244.6031\tactu/index.php\nvide.fr\t\t');
  assert.deepEqual(lu.get('exemple.fr'), { modifiedAt: 1790162244603, modifiedFile: 'actu/index.php' });
  assert.deepEqual(lu.get('vide.fr'), { modifiedAt: null, modifiedFile: null });
  assert.equal(lu.size, 2);
});

test('santé : les trois renseignements arrivent ensemble sur chaque ligne', async () => {
  const ssh = fauxSsh({
    lignes: [sonde(TEMOIN, 404), sonde('a.fr', 200)],
    retouches: [retouche('a.fr', '1790162244.60', 'actu/index.php')],
  });
  const out = await new HealthService(ssh).scan('vps-001', ['a.fr'], { rate: 1e6 });
  const site = out.sites[0];
  assert.equal(site.state, 'ok');
  assert.equal(site.scheme, 'https');
  assert.equal(site.canonical, 'https://a.fr/');
  assert.equal(site.modifiedAt, 1790162244600);
  assert.equal(site.modifiedFile, 'actu/index.php');
});

test('santé : un site qui ne répond PAS garde sa date de dernière retouche', async () => {
  // C'est justement là que la question « depuis quand ? » se pose : un site muet dont on
  // sait qu'il a été touché ce matin ne se diagnostique pas comme un site muet depuis mai.
  const ssh = fauxSsh({
    lignes: [sonde(TEMOIN, 404)],
    retouches: [retouche('muet.fr', '1790000000', 'index.php')],
  });
  const out = await new HealthService(ssh).scan('vps-001', ['muet.fr'], { rate: 1e6 });
  assert.equal(out.sites[0].state, 'no_answer');
  assert.equal(out.sites[0].modifiedFile, 'index.php');
  assert.equal(out.sites[0].modifiedAt, 1790000000000);
});

test('santé : une lecture de dates qui échoue n’emporte pas l’analyse', async () => {
  // La santé du site est le renseignement principal ; la date est un supplément. Perdre le
  // supplément ne doit pas faire perdre le principal.
  const ssh = fauxSsh({
    lignes: [sonde(TEMOIN, 404), sonde('a.fr', 200)],
    surRetouche: () => { throw new Error('disque occupé'); },
  });
  const out = await new HealthService(ssh).scan('vps-001', ['a.fr'], { rate: 1e6 });
  assert.equal(out.sites[0].state, 'ok');
  assert.equal(out.sites[0].modifiedAt, null);
  assert.equal(out.sites[0].modifiedFile, null);
});

test('santé : chaque ligne porte TOUS les champs, même quand rien n’a été mesuré', async () => {
  // Trois endroits construisaient cet objet à la main ; le jour où un champ s'ajoute, l'un
  // des trois l'oublie, et l'écran lit « undefined » sans que rien ne le signale.
  const attendus = ['domain', 'state', 'code', 'time', 'bytes', 'redirect', 'phpErrors', 'canonical', 'scheme', 'modifiedAt', 'modifiedFile'];
  const ssh = fauxSsh({ lignes: [sonde(TEMOIN, 404), sonde('bon.fr', 200)], retouches: [] });
  const out = await new HealthService(ssh).scan('vps-001', ['bon.fr', 'muet.fr', 'pas un domaine'], { rate: 1e6 });
  assert.equal(out.sites.length, 3);
  for (const site of out.sites) {
    for (const champ of attendus) {
      assert.ok(champ in site, `« ${champ} » manque sur un site en état « ${site.state} »`);
    }
  }
});

// ─────────────────────────── le verdict ───────────────────────────

test('santé : chaque état vient de ce qui a été mesuré, pas d’une intuition', () => {
  const v = (row) => verdict({ domain: 'exemple.fr', redirect: null, phpErrors: 0, ...row });
  assert.equal(v({ code: 200, bytes: 50000, time: 0.1 }), 'ok');
  assert.equal(v({ code: 0 }), 'unreachable');
  assert.equal(v({ code: 500 }), 'server_error');
  assert.equal(v({ code: 502 }), 'server_error');
  assert.equal(v({ code: 404 }), 'missing');
  assert.equal(v({ code: 403 }), 'refused');
  assert.equal(v({ code: 200, bytes: 50000, phpErrors: 1 }), 'php_error');
  assert.equal(v({ code: 200, bytes: 120 }), 'empty');
  assert.equal(v({ code: 200, bytes: 50000, time: SEUIL_LENT + 1 }), 'slow');
});

test('santé : une page en panne reste en panne, même lente', () => {
  // L'ordre des contrôles compte : un 500 servi en huit secondes n'est pas « lent ».
  assert.equal(verdict({ domain: 'a.fr', code: 500, time: 9, bytes: 0, phpErrors: 0, redirect: null }), 'server_error');
  // Et un 404 ne dit rien de sa taille.
  assert.equal(verdict({ domain: 'a.fr', code: 404, time: 0.1, bytes: 10, phpErrors: 0, redirect: null }), 'missing');
});

test('santé : le passage en « www » n’est PAS une anomalie', () => {
  // Mesuré : `imagedor.com` rend 301 vers `https://www.imagedor.com/`, et le parc tient
  // une liste de domaines canoniques en « www ». Signaler ces sites aurait noyé les
  // vraies pannes sous des centaines de lignes normales.
  assert.ok(renvoiInterne('imagedor.com', 'https://www.imagedor.com/'));
  assert.ok(renvoiInterne('www.a.fr', 'https://a.fr/'));
  assert.ok(renvoiInterne('a.fr', 'http://a.fr/accueil'));
  assert.ok(!renvoiInterne('a.fr', 'https://autre.com/'));
  assert.ok(!renvoiInterne('a.fr', null));

  assert.equal(verdict({ domain: 'imagedor.com', code: 301, redirect: 'https://www.imagedor.com/', bytes: 178, time: 0.1, phpErrors: 0 }), 'ok');
  assert.equal(verdict({ domain: 'imagedor.com', code: 301, redirect: 'https://ailleurs.net/', bytes: 178, time: 0.1, phpErrors: 0 }), 'redirect');
});

test('santé : le résumé compte ce qui est là, et rien de plus', () => {
  const r = resume([{ state: 'ok' }, { state: 'ok' }, { state: 'slow' }, { state: 'unreachable' }]);
  assert.deepEqual(r, { total: 4, ok: 2, flagged: 0, problems: 2, byState: { ok: 2, slow: 1, unreachable: 1 } });
  assert.deepEqual(resume([]), { total: 0, ok: 0, flagged: 0, problems: 0, byState: {} });
});

test('santé : UN SITE SIGNALÉ EST À REGARDER, même s’il répond parfaitement', () => {
  // LE DÉFAUT RÉPARÉ, en une ligne d'essai. Le 06/10/2026, `gkmtaxzone.com` affichait
  // « site dangereux » dans le navigateur pendant que cet écran annonçait « 0 à
  // regarder » : le site rendait bien une page de 57 ko en 0,14 s, et c'était vrai. Ce
  // que la sonde ne voit pas, c'est la base de réputation que le navigateur consulte
  // AVANT d'ouvrir la page.
  const r = resume([
    { state: 'ok', reputation: { state: 'clean' } },
    { state: 'ok', reputation: { state: 'flagged' } },
    { state: 'ok', reputation: { state: 'unchecked' } },
    { state: 'slow', reputation: { state: 'flagged' } },
  ]);
  assert.equal(r.flagged, 2);
  // Les deux signalés : celui qui répond parfaitement et celui qui est lent. Le site
  // « sain mais non vérifié » n'en fait PAS partie — on ne sait pas, on n'invente pas.
  assert.equal(r.problems, 2, 'le site en ligne mais signalé compte parmi ceux à regarder');
  // `ok` continue de dire ce que la SONDE a vu : trois sites ont bien répondu. Les deux
  // mesures restent lisibles séparément, c'est tout l'intérêt de ne pas les mélanger.
  assert.equal(r.ok, 3);
  assert.equal(r.byState.ok, 3);
  // Un site sans verdict de réputation n'est pas un site signalé : on ne sait pas.
  assert.equal(resume([{ state: 'ok' }]).flagged, 0);
  assert.equal(resume([{ state: 'ok' }]).problems, 0);
});

// ─────────────────────────── l'analyse, de bout en bout ───────────────────────────

test('santé : le témoin ouvre le lot, et son silence annule TOUS les verdicts', async () => {
  // Sans ce garde-fou, un changement de port ferait déclarer 28 177 sites hors service,
  // et l'agent passerait sa journée à chercher une panne qui n'existe pas.
  const ssh = fauxSsh({ lignes: [sonde('exemple.fr', 200)] }); // le témoin ne répond pas
  const health = new HealthService(ssh);
  await assert.rejects(() => health.scan('vps-001', ['exemple.fr'], { rate: 1e6 }), (e) => e.key === 'errors.health_probe_unreachable');
});

test('santé : le témoin ne figure pas dans les résultats', async () => {
  const ssh = fauxSsh({ lignes: [sonde(TEMOIN, 404, { bytes: 160 }), sonde('exemple.fr', 200)] });
  const out = await new HealthService(ssh).scan('vps-001', ['exemple.fr'], { rate: 1e6 });
  assert.deepEqual(out.sites.map((s) => s.domain), ['exemple.fr']);
  assert.equal(out.summary.total, 1);
});

test('santé : un nom qui n’est pas un domaine est écarté SANS être sondé', async () => {
  const ssh = fauxSsh({ lignes: [sonde(TEMOIN, 404), sonde('bon.fr', 200)] });
  const out = await new HealthService(ssh).scan('vps-001', ['bon.fr', 'pas un domaine', 'exemple.fr; rm -rf /'], { rate: 1e6 });
  const etats = Object.fromEntries(out.sites.map((s) => [s.domain, s.state]));
  assert.equal(etats['bon.fr'], 'ok');
  assert.equal(etats['pas un domaine'], 'invalid');
  assert.equal(etats['exemple.fr; rm -rf /'], 'invalid');
  // Et la commande n'a pas vu passer ces noms.
  const commande = ssh.vues.find((c) => c.includes('curl'));
  assert.ok(!commande.includes('rm -rf'), 'un nom refusé ne part pas sur le serveur');
});

test('santé : une sonde dont la ligne manque n’est PAS comptée comme saine', async () => {
  // Un site muet dont la ligne se perd ressemblerait à un site en bonne santé, et
  // personne ne saurait qu'il n'a jamais été mesuré.
  const ssh = fauxSsh({ lignes: [sonde(TEMOIN, 404), sonde('vu.fr', 200)] });
  const out = await new HealthService(ssh).scan('vps-001', ['vu.fr', 'perdu.fr'], { rate: 1e6 });
  assert.equal(out.sites.find((s) => s.domain === 'perdu.fr').state, 'no_answer');
  assert.equal(out.summary.ok, 1);
  assert.equal(out.summary.problems, 1);
});

test('santé : un site demandé deux fois n’est sondé qu’une', async () => {
  const ssh = fauxSsh({ lignes: [sonde(TEMOIN, 404), sonde('a.fr', 200)] });
  const out = await new HealthService(ssh).scan('vps-001', ['a.fr', 'A.FR', ' a.fr '], { rate: 1e6 });
  assert.equal(out.summary.total, 1);
});

test('santé : aucune cible, aucun appel au serveur', async () => {
  const ssh = fauxSsh();
  await assert.rejects(() => new HealthService(ssh).scan('vps-001', []), (e) => e.key === 'errors.health_no_target');
  assert.equal(ssh.vues.length, 0, 'et pas même une lecture de charge');
});

// ─────────────────────────── le frein ───────────────────────────

test('santé : la charge est lue AVANT la première sonde', async () => {
  const ssh = fauxSsh({ charge: '4.0\n8\n0', lignes: [sonde(TEMOIN, 404), sonde('a.fr', 200)] });
  const out = await new HealthService(ssh).scan('vps-001', ['a.fr'], { rate: 1e6 });
  assert.match(ssh.vues[0], /\/proc\/loadavg/, 'la charge d’abord, la sonde ensuite');
  assert.match(ssh.vues[1], /curl/);
  assert.deepEqual(out.load, { load: 4, cores: 8, parCoeur: 0.5, io: 0 });
});

test('santé : une machine à genoux fait RENONCER l’analyse, elle ne l’aggrave pas', async () => {
  // 138 de charge moyenne sur 8 cœurs : c'est ce qu'une analyse trop pressée a provoqué
  // le 02/10/2026. Au-delà du plafond, le lot patiente, puis abandonne en le disant.
  const ssh = fauxSsh({ charge: '138.0\n8\n0', lignes: [sonde(TEMOIN, 404)] });
  const health = new HealthService(ssh);
  await assert.rejects(
    () => health.scan('vps-001', ['a.fr'], { maxWait: 0, loadCeiling: CHARGE_MAX, rate: 1e6 }),
    (e) => e.key === 'errors.health_server_busy' && e.vars.load === '138.00' && e.vars.cores === '8',
  );
  assert.ok(!ssh.vues.some((c) => c.includes('curl')), 'aucune sonde n’a été lancée');
});

test('santé : le plafond se cale sur ce que la machine fait D’HABITUDE', async () => {
  // Mesuré : vps-002 vit à 1,78 par cœur au repos, vps-001 à 0,75. Un plafond fixe
  // bloquerait l'une et laisserait l'autre libre — il ne protégerait ni l'une ni l'autre.
  const ssh = fauxSsh({ charge: '14.24\n8\n0', lignes: [sonde(TEMOIN, 404), sonde('a.fr', 200)] });
  const health = new HealthService(ssh);
  // 14,24 / 8 = 1,78 par cœur : au-dessus de CHARGE_MAX, et pourtant accepté, parce que
  // c'est l'état normal de cette machine.
  assert.ok(1.78 > CHARGE_MAX - 0.25, 'la mesure doit bien être proche du plafond fixe');
  const out = await health.scan('vps-001', ['a.fr'], { rate: 1e6 });
  assert.equal(out.summary.ok, 1);
  assert.equal(health.load.repos.get('vps-001').toFixed(2), '1.78');
  // Et le second lot s'autorise cette référence plus la marge, pas davantage.
  assert.ok(MARGE_CHARGE > 0 && MARGE_CHARGE < 2);
});

test('santé : un lot plus rapide que le débit visé ATTEND avant de rendre', async () => {
  // C'est le débit qui protège la machine, et non le nombre de sondes simultanées :
  // le coût est le réveil des pools php-fpm, un par site.
  const ssh = fauxSsh({ lignes: [sonde(TEMOIN, 404), sonde('a.fr', 200), sonde('b.fr', 200), sonde('c.fr', 200)] });
  const t = Date.now();
  await new HealthService(ssh).scan('vps-001', ['a.fr', 'b.fr', 'c.fr'], { rate: 20 });
  const ecoule = Date.now() - t;
  // 3 sites à 20/s = 150 ms au moins. La borne haute garde le test rapide.
  assert.ok(ecoule >= 140, `le frein doit retenir le lot (${ecoule} ms)`);
  assert.ok(ecoule < 3000, `mais pas l’endormir (${ecoule} ms)`);
});

test('santé : le port du serveur l’emporte sur le port par défaut', async () => {
  const ssh = fauxSsh({ httpPort: 8099, lignes: [sonde(TEMOIN, 404), sonde('a.fr', 200)] });
  await new HealthService(ssh).scan('vps-001', ['a.fr'], { rate: 1e6 });
  assert.match(ssh.vues.find((c) => c.includes('curl')), /127\.0\.0\.1:8099/);
});

// ─────────────────────────── ce que l'écran et le moteur doivent garder ───────────────────────────

test('santé : le traitement est une ANALYSE, et exige le droit d’analyse', async () => {
  const { buildJobKinds } = await import('../src/services/jobKinds.js');
  const kinds = buildJobKinds({ translation: {}, categories: {}, redirects: {}, cloudflare: {}, health: {} });
  const kind = kinds['health.scan'];
  assert.ok(kind, 'le traitement doit être au catalogue');
  assert.equal(kind.permission, 'bulk.read', 'rien n’est écrit : le droit d’écriture n’a pas à être exigé');
  assert.equal(kind.perServer, true, 'une sonde s’adresse à une machine précise');
  assert.ok(kind.batch <= 100, 'des lots courts : le frein a besoin de respirer entre eux');
});

test('santé : aucune des commandes envoyées n’écrit sur le serveur', () => {
  // CE SONT LES COMMANDES QU'ON EXAMINE, et non le texte du fichier. Une première version
  // lisait le source : elle s'est mise à échouer sur la phrase « tous déclarent
  // https://<domaine>/ » d'un commentaire, où « > » suivi d'une barre ressemble à une
  // redirection de flux. Un test qui crie au loup finit par être désactivé.
  const commandes = [
    probeCommand(['exemple.fr']),
    touchCommand('/srv/www', ['exemple.fr']),
    "awk '{print $1}' /proc/loadavg; nproc",
  ];
  for (const cmd of commandes) {
    for (const interdit of [/\bmkdir\b/, /\bchmod\b/, /\btee\b/, /\brm\b/, /\btouch\b/, /\bcp\b/, /\bmv\b/, /\bdd\b/, /\btruncate\b/]) {
      assert.ok(!interdit.test(cmd), `une commande ne doit rien écrire : ${interdit} dans ${cmd.slice(0, 60)}…`);
    }
    // La seule redirection de flux admise envoie au vide. Le « > » doit suivre un blanc
    // pour compter : dans le programme awk, « [^>] » en porte un qui ne redirige rien.
    for (const [, cible] of cmd.matchAll(/(?:^|\s)\d?>\s*(\S+)/g)) {
      assert.equal(cible, '/dev/null', `une redirection vers ${cible} écrirait sur le serveur`);
    }
  }
  // Et le service ne connaît aucun moyen d'écrire, même inemployé.
  const src = readFileSync(join(RACINE, 'src/services/healthService.js'), 'utf8');
  assert.ok(!/file_put_contents|writeFile|createWriteStream/.test(src));
  assert.match(src, /curl -s/, 'il ne fait que demander une page');
});

test('santé : l’écran est branché, et son état par défaut ne modifie rien', () => {
  const actions = readFileSync(join(RACINE, 'public/js/actions.js'), 'utf8');
  assert.match(actions, /import \{ healthAction \} from '\.\/health\.js';/);
  // En tête de liste : c'est l'action par défaut de l'écran, et la seule qui ne touche
  // à rien. Ouvrir « Actions » ne doit jamais présenter d'emblée un traitement qui écrit.
  assert.match(actions, /const ACTIONS = \[healthAction,/);
});

test('santé : tous les états ont un libellé dans les six langues', () => {
  // Un état sans libellé s'afficherait en clé brute à l'agent — c'est exactement ce qui
  // était arrivé aux droits Cloudflare.
  const etats = ['ok', 'slow', 'empty', 'php_error', 'redirect', 'refused', 'missing', 'server_error', 'unreachable', 'no_answer', 'invalid'];
  for (const langue of ['fr', 'en', 'es', 'it', 'pt', 'de']) {
    const textes = JSON.parse(readFileSync(join(RACINE, 'locales', `${langue}.json`), 'utf8'));
    assert.equal(typeof textes.actions?.health, 'string', `${langue} : « actions.health » manque`);
    for (const etat of etats) {
      const libelle = textes.health?.[`state_${etat}`];
      assert.equal(typeof libelle, 'string', `${langue} : « health.state_${etat} » manque`);
      assert.ok(libelle.trim().length > 0);
    }
    for (const cle of ['health_no_target', 'health_probe_unreachable', 'health_server_busy']) {
      assert.equal(typeof textes.errors?.[cle], 'string', `${langue} : « errors.${cle} » manque`);
    }
    // Les deux phrases qui empêchent l'écran de mentir : l'une explique une lenteur par la
    // machine, l'autre dit qu'une analyse sans résultat n'est pas un parc en bonne santé.
    for (const cle of ['busy_note', 'nothing_measured', 'all_good', 'only_problems', 'explain', 'col_proto', 'col_modified', 'col_file']) {
      assert.equal(typeof textes.health?.[cle], 'string', `${langue} : « health.${cle} » manque`);
      assert.ok(textes.health[cle].trim().length > 10);
    }
  }
});

test('santé : une analyse sans résultat ne se dit pas « tout va bien »', () => {
  // Les deux phrases doivent rester DISTINCTES. Elles l'ont été confondues : l'écran
  // affichait « tous les sites répondent normalement » après une analyse où tous les lots
  // avaient échoué, c'est-à-dire où rien n'avait été mesuré.
  for (const langue of ['fr', 'en', 'es', 'it', 'pt', 'de']) {
    const { health } = JSON.parse(readFileSync(join(RACINE, 'locales', `${langue}.json`), 'utf8'));
    assert.notEqual(health.nothing_measured, health.all_good, `${langue} : les deux phrases ne doivent pas être la même`);
  }
  const ecran = readFileSync(join(RACINE, 'public/js/health.js'), 'utf8');
  assert.match(ecran, /emptyState: \(\) =>[\s\S]{0,200}health\.nothing_measured/);
});

test('santé : la charge retenue est la PIRE machine, pas la dernière', () => {
  // Garder la dernière donnait 14,2 pour vps-002 alors que vps-001, à 22,9, était le seul
  // à peiner : l'agent lisait le chiffre rassurant.
  const ecran = readFileSync(join(RACINE, 'public/js/health.js'), 'utf8');
  assert.match(ecran, /out\.load\.parCoeur > state\.charge\.parCoeur/);
  // Et la charge moyenne d'une machine Linux n'a pas sa place dans une tuile de bilan :
  // elle ne veut rien dire pour qui ne l'a jamais lue.
  assert.ok(!/stat_load/.test(ecran), 'la charge se dit en une phrase, pas en tuile');
  assert.match(ecran, /health\.busy_note/);
});

test('santé : les messages d’erreur nomment leurs variables', () => {
  // Un message qui annonce « {server} » sans que le code le fournisse afficherait
  // l'accolade à l'agent.
  const textes = JSON.parse(readFileSync(join(RACINE, 'locales/fr.json'), 'utf8'));
  assert.match(textes.errors.health_probe_unreachable, /\{server\}.*\{port\}/);
  assert.match(textes.errors.health_server_busy, /\{server\}.*\{load\}.*\{cores\}/);
  // Et le texte doit DIRE que ce n'est pas une panne des sites : c'est tout l'intérêt.
  assert.match(textes.errors.health_probe_unreachable, /pas les sites|mesure/i);
});

test('santé : la date s’affiche dans le fuseau de l’agent, pas dans celui du serveur', () => {
  // Les serveurs vivent en UTC et l'agent trois heures devant. Une date recopiée telle
  // quelle lui ferait chercher une modification à une heure où rien ne s'est passé.
  const ecran = readFileSync(join(RACINE, 'public/js/health.js'), 'utf8');
  assert.match(ecran, /fmtDate\(s\.modifiedAt\)/, 'la date passe par le formateur de l’écran');
  assert.ok(!/toISOString|toUTCString/.test(ecran), 'et jamais par une date en UTC brut');
  assert.match(ecran, /s\.modifiedFile/, 'le fichier concerné est affiché');
});

test('santé : le protocole est une pastille, pas une colonne', () => {
  // Sur cent sites mesurés, cent se déclarent en « https ». Une colonne entière pour
  // répéter la même chose fatigue l'œil ; l'exception doit ressortir, pas se noyer.
  const ecran = readFileSync(join(RACINE, 'public/js/health.js'), 'utf8');
  assert.match(ecran, /function pastilleProtocole/);
  assert.match(ecran, /s\.scheme === 'http'/, 'c’est « http » qui doit alerter');
  assert.match(ecran, /amber/, 'et il est teinté autrement que les autres');
  // L'adresse exacte reste accessible : c'est elle qui a servi à décider.
  assert.match(ecran, /title: s\.canonical/);
  // Et « col_proto » ne sert que d'info-bulle : il ne doit pas devenir un en-tête de colonne.
  assert.ok(!/'th'[^)]*health\.col_proto/.test(ecran), 'pas d’en-tête de colonne pour le protocole');
});

test('santé : les seuils restent ceux qui ont été mesurés', () => {
  // Changer un seuil sans mesurer, c'est ramener les faux signalements. 5 s parce qu'une
  // machine à 1,8 par cœur sert parfois une page saine en 4 s ; 1 000 octets parce
  // qu'une page de ce moteur en pèse 45 000 à 66 000.
  assert.equal(SEUIL_LENT, 5);
  assert.equal(SEUIL_VIDE, 1000);
  assert.equal(PORT_DEFAUT, 8080);
});

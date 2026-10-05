import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  CHARGE_ALERTE,
  CHARGE_CRITIQUE,
  DISQUE_ALERTE,
  DISQUE_CRITIQUE,
  LIBRE_ALERTE,
  LIBRE_CRITIQUE,
  PRESSION_ALERTE,
  PRESSION_CRITIQUE,
  ServerStateService,
  disqueSurveille,
  parseState,
  stateCommand,
  verdictDisque,
  verdictInodes,
} from '../src/services/serverStateService.js';

/**
 * L'état des machines : disque, mémoire, charge, services.
 *
 * LE TÉMOIN CI-DESSOUS EST UNE SORTIE RÉELLE de vps-001, prise le 05/10/2026, lignes
 * encombrantes comprises. Elle contient dix `tmpfs` et quatre `snapfuse` À 100 %, et c'est
 * tout l'intérêt : un écran qui les compterait annoncerait « disque plein » tous les jours
 * de l'année, et plus personne ne le regarderait.
 */
const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');

const TEMOIN = `#LOAD
5.35 7.48 8.12 5/1062 1542119
8
#IO
avg10=6.09
#MEMPRESS
avg10=3.24
#MEM
MemTotal:       24021656 kB
MemAvailable:   16029006 kB
Cached:          7742804 kB
SwapTotal:       2097148 kB
SwapFree:        1749052 kB
#DF
Filesystem     Type              1-blocks         Used   Available Capacity Mounted on
/dev/sda1      ext4          207071854592 178578145280 28476932096      87% /
none           tmpfs               503808         4096      499712       1% /dev
tmpfs          tmpfs          12299087872            0 12299087872       0% /dev/shm
snapfuse       fuse.snapfuse     63045632     63045632           0     100% /snap/core26/462
snapfuse       fuse.snapfuse    128188416    128188416           0     100% /snap/lxd/40424
tmpfs          tmpfs           2459815936         8192  2459807744       1% /run/user/1004
/dev/sdb1      ext4          105087164416  84648361984 15053422592      85% /data/www
snapfuse       fuse.snapfuse     52822016     52822016           0     100% /snap/snapd/27738
#INODES
Filesystem     Type            Inodes   IUsed    IFree IUse% Mounted on
/dev/sda1      ext4          24962560 3139351 21823209   13% /
none           tmpfs          3002707      26  3002681    1% /dev
snapfuse       fuse.snapfuse     6808    6808        0  100% /snap/core26/462
/dev/sdb1      ext4           6553600 1488397  5065203   23% /data/www
#UPTIME
4017183
#PROCS
10
473
2
#LISTEN
127.0.0.54:53 127.0.0.1:22 0.0.0.0:8080 [::]:8080
#SITES
7733
#END
`;

/** La même machine, mais en pleine crise : les chiffres relevés sur vps-003. */
const TEMOIN_CRISE = TEMOIN.replace('5.35 7.48 8.12 5/1062 1542119', '216.01 252.62 236.87 18/1402 1145582')
  .replace('#IO\navg10=6.09', '#IO\navg10=99.41')
  .replace('#MEMPRESS\navg10=3.24', '#MEMPRESS\navg10=89.70')
  .replace('Cached:          7742804 kB', 'Cached:          2100000 kB')
  .replace('#PROCS\n10\n473\n2', '#PROCS\n10\n635\n363');

const trouve = (etat, key, mount = null) => etat.checks.find((c) => c.key === key && (mount === null || c.mount === mount));

/** Un faux parc : aucune connexion, et un journal de ce qui a été demandé. */
function fauxSsh({ sortie = TEMOIN, connecte = true, jette = null } = {}) {
  const vues = [];
  return {
    vues,
    server: () => ({ id: 'vps-001', label: 'VPS 001', host: '10.0.0.1', wwwRoot: '/srv/www' }),
    isConnected: () => connecte,
    exec: async (id, cmd) => {
      vues.push(cmd);
      if (jette) throw jette;
      return { stdout: typeof sortie === 'function' ? sortie(vues.length) : sortie };
    },
  };
}

// ─────────────────────────── la commande ───────────────────────────

test('état : une seule commande, et elle n’écrit rien', () => {
  const cmd = stateCommand({ wwwRoot: '/srv/www' });
  for (const interdit of [/\bmkdir\b/, /\bchmod\b/, /\brm\b/, /\btee\b/, /\bcp\b/, /\bmv\b/, /\btouch\b/, /\bkill\b/, /systemctl/, /\bservice\b/]) {
    assert.ok(!interdit.test(cmd), `l’état ne doit rien changer : ${interdit}`);
  }
  for (const [, cible] of cmd.matchAll(/(?:^|\s)\d?>\s*(\S+)/g)) assert.equal(cible, '/dev/null');
});

test('état : la racine des sites est CITÉE, jamais recopiée brute', () => {
  assert.match(stateCommand({ wwwRoot: "/srv/www'; rm -rf / #" }), /'\/srv\/www'\\''; rm -rf \/ #'/);
  // Sans racine, la section n'existe pas : on ne compte pas des sites qu'on ne sait pas où chercher.
  assert.ok(!stateCommand({}).includes('#SITES'));
});

test('état : la section qui suit un « tr » doit survivre', () => {
  // `tr '\\n' ' '` ne laisse pas de retour à la ligne : le repère suivant se collait à la
  // fin de cette ligne, et la section d'après disparaissait sans un mot. C'est arrivé à
  // « #SITES », qui n'a jamais remonté avant correction.
  const cmd = stateCommand({ wwwRoot: '/srv/www' });
  const ligneTr = cmd.split('\n').find((l) => l.includes("tr '\\n' ' '"));
  assert.ok(ligneTr, 'la ligne doit exister');
  assert.match(ligneTr, /;\s*echo$/, 'elle doit se terminer par un retour à la ligne explicite');
});

// ─────────────────────────── la lecture ───────────────────────────

test('état : les faux disques sont ÉCARTÉS, et c’est vital', () => {
  // Dix `tmpfs` et quatre `snapfuse` à 100 % dans le témoin. Les compter annoncerait
  // « disque plein » en permanence.
  const e = parseState(TEMOIN);
  const disques = e.checks.filter((c) => c.key === 'disk');
  assert.deepEqual(disques.map((d) => d.mount), ['/', '/data/www']);
  assert.ok(!e.checks.some((c) => String(c.mount ?? '').startsWith('/snap')));
  assert.ok(!e.checks.some((c) => String(c.mount ?? '').startsWith('/dev')));
  assert.ok(!e.checks.some((c) => String(c.mount ?? '').startsWith('/run')));
});

test('état : la règle du vrai disque, prise isolément', () => {
  assert.ok(disqueSurveille({ type: 'ext4', mount: '/', total: 100 }));
  assert.ok(disqueSurveille({ type: 'xfs', mount: '/data/www', total: 100 }));
  assert.ok(!disqueSurveille({ type: 'tmpfs', mount: '/run', total: 100 }));
  assert.ok(!disqueSurveille({ type: 'fuse.snapfuse', mount: '/snap/lxd/1', total: 100 }));
  assert.ok(!disqueSurveille({ type: 'ext4', mount: '/snap/core26/462', total: 100 }), 'un vrai système de fichiers monté dans /snap non plus');
  assert.ok(!disqueSurveille({ type: 'ext4', mount: '/boot/efi', total: 100 }));
  assert.ok(!disqueSurveille({ type: 'ext4', mount: '/', total: 0 }), 'un disque de taille nulle ne dit rien');
  assert.ok(!disqueSurveille(null));
});

test('état : chaque chiffre du témoin se relit correctement', () => {
  const e = parseState(TEMOIN);
  assert.equal(e.state, 'ok');
  assert.equal(e.uptime, 4017183);
  assert.equal(e.sites, 7733);
  assert.ok(e.listening.includes('0.0.0.0:8080'));

  assert.equal(trouve(e, 'load').value, 5.35);
  assert.equal(trouve(e, 'load').cores, 8);
  assert.ok(Math.abs(trouve(e, 'load').perCore - 0.66875) < 1e-6);
  assert.equal(trouve(e, 'io').value, 6.09);
  assert.equal(trouve(e, 'mempress').value, 3.24);
  assert.equal(trouve(e, 'nginx').value, 10);
  assert.equal(trouve(e, 'php').value, 473);
  assert.equal(trouve(e, 'blocked').value, 2);

  // Les kilo-octets de /proc/meminfo deviennent des octets : l'écran met en forme, pas
  // le serveur, et une unité qui se promène finit par être affichée de travers.
  assert.equal(trouve(e, 'memory').total, 24021656 * 1024);
  assert.equal(trouve(e, 'cache').bytes, 7742804 * 1024);

  const racine = trouve(e, 'disk', '/');
  assert.equal(racine.value, 87);
  assert.equal(racine.total, 207071854592);
  assert.equal(racine.avail, 28476932096);
  assert.equal(trouve(e, 'inodes', '/').value, 13);
  assert.equal(trouve(e, 'inodes', '/data/www').used, 1488397);
});

test('état : une sortie vide ou tronquée ne jette pas', () => {
  // Un serveur qui coupe la communication au milieu ne doit pas faire tomber l'écran.
  for (const brut of ['', '#LOAD\n', TEMOIN.slice(0, 200), '#END']) {
    const e = parseState(brut);
    assert.ok(typeof e.state === 'string');
    assert.ok(Array.isArray(e.checks));
  }
});

// ─────────────────────────── les verdicts ───────────────────────────

test('état : LE DISQUE DEMANDE DEUX CONDITIONS, et voici pourquoi', () => {
  // 87 % d'une partition de 193 Go laisse 27 Go : ce n'est pas une urgence. Le parc vit
  // entre 63 et 87 % — alerter sur le seul pourcentage aurait signalé trois machines sur
  // cinq, tous les jours, pour rien.
  assert.equal(verdictDisque({ percent: 87, avail: 28e9 }), 'ok');
  assert.equal(verdictDisque({ percent: 85, avail: 15e9 }), 'ok');
  // Mais 87 % d'une petite partition, c'est une autre nouvelle.
  assert.equal(verdictDisque({ percent: 87, avail: 1.5e9 }), 'critical');
  assert.equal(verdictDisque({ percent: 91, avail: 4e9 }), 'warn');
  // Et un disque vraiment plein alerte même si le pourcentage mentait.
  assert.equal(verdictDisque({ percent: 50, avail: 1e9 }), 'critical');
  assert.equal(verdictDisque({ percent: 96, avail: 50e9 }), 'warn', 'au-dela du seuil, on prévient même avec de la place');
  assert.ok(LIBRE_CRITIQUE < LIBRE_ALERTE);
  assert.ok(DISQUE_ALERTE < DISQUE_CRITIQUE);
});

test('état : les inodes se jugent sur le seul pourcentage', () => {
  // Il n'y a pas d'« espace libre en octets » pour des inodes, et un disque peut les
  // épuiser en gardant des gigaoctets libres. 28 177 sites de ~559 fichiers : ce n'est
  // pas une hypothèse d'école ici.
  assert.equal(verdictInodes(23), 'ok');
  assert.equal(verdictInodes(DISQUE_ALERTE), 'warn');
  assert.equal(verdictInodes(DISQUE_CRITIQUE), 'critical');
});

test('état : une machine en crise ressort CRITIQUE, et la cause est nommée', () => {
  // Les chiffres relevés sur vps-003 le 05/10/2026 : 216 de charge, 99,4 % d'attente
  // disque, 89,7 % d'attente mémoire, le cache de page tombé de 7,4 à 2,1 Go, et 363
  // tâches bloquées. La pression CPU, elle, était à 23 % : ces machines manquent de
  // disque, pas de processeur.
  const e = parseState(TEMOIN_CRISE);
  assert.equal(e.state, 'critical');
  assert.equal(trouve(e, 'load').state, 'critical');
  assert.equal(trouve(e, 'io').state, 'critical');
  assert.equal(trouve(e, 'mempress').state, 'critical');
  assert.equal(trouve(e, 'blocked').state, 'critical');
  // Le cache de page est l'indicateur le plus parlant de ce parc : 2,1 Go sur 23, soit 9 %.
  assert.equal(trouve(e, 'cache').state, 'warn');
  // Et les disques, eux, allaient bien : la crise n'est pas une histoire d'espace.
  assert.equal(trouve(e, 'disk', '/').state, 'ok');
});

test('état : le verdict d’ensemble est celui du PIRE contrôle', () => {
  // Un seul disque plein suffit à rendre la machine critique : le reste peut bien aller.
  const plein = TEMOIN.replace(
    '/dev/sdb1      ext4          105087164416  84648361984 15053422592      85% /data/www',
    '/dev/sdb1      ext4          105087164416 104087164416    500000000      99% /data/www',
  );
  const e = parseState(plein);
  assert.equal(e.state, 'critical');
  assert.equal(trouve(e, 'disk', '/data/www').state, 'critical');
  assert.equal(trouve(e, 'disk', '/').state, 'ok');
});

test('état : un serveur web arrêté est CRITIQUE sans demi-mesure', () => {
  // nginx arrêté, ce sont tous les sites de la machine qui ne répondent plus. Il n'y a pas
  // de « à surveiller » dans ce cas.
  const e = parseState(TEMOIN.replace('#PROCS\n10\n473\n2', '#PROCS\n0\n473\n2'));
  assert.equal(trouve(e, 'nginx').state, 'critical');
  assert.equal(e.state, 'critical');
  const sansPhp = parseState(TEMOIN.replace('#PROCS\n10\n473\n2', '#PROCS\n10\n0\n2'));
  assert.equal(trouve(sansPhp, 'php').state, 'critical');
});

test('état : les seuils restent ceux qui ont été mesurés', () => {
  // Mesuré sur les cinq machines : charge 0,20 à 1,00 par cœur au repos ; pression disque
  // 0 à 9 % sain, 99,4 % en crise. Changer un seuil sans mesurer ramène les fausses alertes.
  assert.equal(CHARGE_ALERTE, 2);
  assert.equal(CHARGE_CRITIQUE, 4);
  assert.equal(PRESSION_ALERTE, 25);
  assert.equal(PRESSION_CRITIQUE, 50);
  assert.equal(DISQUE_ALERTE, 90);
  assert.equal(DISQUE_CRITIQUE, 95);
});

// ─────────────────────────── le service ───────────────────────────

test('état : un serveur NON CONNECTÉ n’est pas un serveur en panne', () => {
  // Le dire « hors ligne » et non « critique » : la cause est ici, pas là-bas, et aucun
  // geste n'est à faire sur la machine.
  const ssh = fauxSsh({ connecte: false });
  return new ServerStateService(ssh).one('vps-001').then((e) => {
    assert.equal(e.state, 'offline');
    assert.deepEqual(e.checks, []);
    assert.equal(ssh.vues.length, 0, 'et on ne lui demande rien');
  });
});

test('état : une lecture qui échoue donne « inconnu », pas « en bon état »', async () => {
  // Un serveur dont on ne sait rien n'est pas un serveur qui va bien.
  const ssh = fauxSsh({ jette: Object.assign(new Error('session perdue'), { key: 'errors.ssh_timeout' }) });
  const e = await new ServerStateService(ssh).one('vps-001');
  assert.equal(e.state, 'unknown');
  assert.equal(e.error, 'errors.ssh_timeout');
  assert.equal(e.label, 'VPS 001');
});

test('état : le cache évite de redemander, et « fresh » le contourne', async () => {
  const ssh = fauxSsh();
  const svc = new ServerStateService(ssh, { ttl: 60000 });
  await svc.one('vps-001');
  await svc.one('vps-001');
  assert.equal(ssh.vues.length, 1, 'la seconde demande vient du cache');
  await svc.one('vps-001', { fresh: true });
  assert.equal(ssh.vues.length, 2, '« Actualiser » doit vraiment relire');
  svc.forget();
  await svc.one('vps-001');
  assert.equal(ssh.vues.length, 3);
});

test('état : une erreur n’est PAS mise en cache', async () => {
  // Sinon une coupure d'une seconde laisserait « état inconnu » affiché pendant un quart
  // d'heure, et l'agent croirait le serveur perdu.
  let premier = true;
  const ssh = {
    vues: [],
    server: () => ({ id: 'vps-001', label: 'VPS 001', host: '10.0.0.1', wwwRoot: '/srv/www' }),
    isConnected: () => true,
    exec: async (id, cmd) => {
      ssh.vues.push(cmd);
      if (premier) { premier = false; throw new Error('coupure'); }
      return { stdout: TEMOIN };
    },
  };
  const svc = new ServerStateService(ssh, { ttl: 60000 });
  assert.equal((await svc.one('vps-001')).state, 'unknown');
  assert.equal((await svc.one('vps-001')).state, 'ok', 'la lecture suivante doit repartir');
});

test('état : plusieurs serveurs sont lus EN PARALLÈLE', async () => {
  // Cinq lectures à la suite prendraient huit secondes ; ensemble, moins de deux.
  const ssh = {
    server: (id) => ({ id, label: id, host: '10.0.0.1', wwwRoot: '/srv/www' }),
    isConnected: () => true,
    exec: async () => {
      await new Promise((r) => setTimeout(r, 120));
      return { stdout: TEMOIN };
    },
  };
  const t = Date.now();
  const tous = await new ServerStateService(ssh).many(['a', 'b', 'c', 'd', 'e']);
  const ecoule = Date.now() - t;
  assert.equal(tous.length, 5);
  assert.ok(ecoule < 400, `en parallèle, pas à la suite (${ecoule} ms pour 5 × 120 ms)`);
});

// ─────────────────────────── la route et l'écran ───────────────────────────

test('état : la route exige le droit de se connecter, et rien de plus', () => {
  const route = readFileSync(join(RACINE, 'src/routes/servers.js'), 'utf8');
  assert.match(route, /r\.get\('\/state', canConnect,/);
  assert.match(route, /r\.get\('\/:id\/state', canConnect, access,/);
  // Elle ne voit que les serveurs permis à l'utilisateur.
  assert.match(route, /visibleServers\(req\.user, ssh\.list\(\)\)/);
  // Et c'est bien une lecture : aucun POST, PATCH ni DELETE sur l'état.
  assert.ok(!/r\.(post|patch|delete)\('\/state'/.test(route));
});

test('état : l’écran est enregistré comme les autres vues plein écran', () => {
  const app = readFileSync(join(RACINE, 'public/js/app.js'), 'utf8');
  // La table des écrans est le seul endroit qui les ferme : un écran absent restait
  // affiché sous le suivant.
  assert.match(app, /health: closeServerState,/);
  assert.match(app, /\$\('#nav-health'\)\.hidden = !can\('servers\.connect'\)/);
  const html = readFileSync(join(RACINE, 'public/index.html'), 'utf8');
  assert.match(html, /id="health-view"/);
  assert.match(html, /id="nav-health"/);
  assert.match(html, /data-i18n="srvstate\.title"/);
});

test('état : les machines en peine passent EN PREMIER', () => {
  // Cinq cartes dont une critique : la critique en haut. L'ordre est la première chose
  // qui informe, avant même de lire.
  const ecran = readFileSync(join(RACINE, 'public/js/serverState.js'), 'utf8');
  assert.match(ecran, /const RANG = \{ critical: 0, warn: 1,/);
  assert.match(ecran, /\.sort\(\(a, b\) => \(RANG\[a\.state\] \?\? 9\) - \(RANG\[b\.state\] \?\? 9\)/);
});

test('état : la cause est dite EN MOTS, pas en chiffres', () => {
  // Un agent à qui l'on montre « pression I/O 99,4 % » ne sait pas quoi en faire. La même
  // mesure en mots se transmet telle quelle à l'administrateur.
  const ecran = readFileSync(join(RACINE, 'public/js/serverState.js'), 'utf8');
  assert.match(ecran, /function causes\(/);
  for (const cle of ['why_disk', 'why_io', 'why_load', 'why_cache', 'why_nginx']) {
    assert.ok(ecran.includes(`srvstate.${cle}`), `« ${cle} » doit être employé`);
  }
  // Deux griefs au plus : une liste de six ne se lit pas.
  assert.match(ecran, /\.slice\(0, 2\)/);
  // Et les nombres passent par le formateur de langue, pas par toFixed.
  assert.ok(!/\.toFixed\(/.test(ecran), 'toFixed écrit un point décimal anglais');
});

test('état : tous les libellés existent dans les six langues', () => {
  const cles = [
    'title', 'subtitle', 'refresh', 'loading', 'none', 'summary_ok', 'summary_bad',
    'state_ok', 'state_warn', 'state_critical', 'state_offline', 'state_unknown',
    'offline_hint', 'sites', 'since_days', 'since_hours',
    'group_disk', 'group_machine', 'disk_value', 'inodes_value',
    'load', 'load_value', 'io', 'memory', 'cache', 'swap', 'blocked', 'nginx', 'php',
    'running', 'stopped',
    'why_disk', 'why_inodes', 'why_io', 'why_mempress', 'why_load', 'why_memory',
    'why_cache', 'why_swap', 'why_blocked', 'why_nginx', 'why_php',
  ];
  for (const langue of ['fr', 'en', 'es', 'it', 'pt', 'de']) {
    const { srvstate } = JSON.parse(readFileSync(join(RACINE, 'locales', `${langue}.json`), 'utf8'));
    assert.ok(srvstate, `${langue} : la section « srvstate » manque`);
    for (const cle of cles) {
      assert.equal(typeof srvstate[cle], 'string', `${langue} : « srvstate.${cle} » manque`);
      assert.ok(srvstate[cle].trim().length > 0);
    }
  }
});

test('état : les phrases de diagnostic nomment leurs variables', () => {
  // Une phrase qui annonce « {percent} » sans que le code le fournisse afficherait
  // l'accolade à l'agent.
  const { srvstate } = JSON.parse(readFileSync(join(RACINE, 'locales/fr.json'), 'utf8'));
  assert.match(srvstate.why_disk, /\{mount\}.*\{percent\}.*\{free\}/);
  assert.match(srvstate.why_load, /\{load\}.*\{cores\}/);
  assert.match(srvstate.why_io, /\{percent\}/);
  assert.match(srvstate.why_cache, /\{size\}/);
  assert.match(srvstate.disk_value, /\{percent\}.*\{free\}.*\{total\}/);
  assert.match(srvstate.load_value, /\{load\}.*\{cores\}.*\{perCore\}/);
  // Et la phrase du disque doit nommer ce qui RESTE, pas seulement le pourcentage : c'est
  // la seule des deux qui décide si c'est grave.
  assert.ok(srvstate.why_disk.includes('{free}'));
});

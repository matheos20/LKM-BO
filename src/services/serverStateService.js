import { shq } from '../ssh/shell.js';

/**
 * L'état d'une machine : disque, mémoire, charge, services.
 *
 * UNE SEULE COMMANDE PAR SERVEUR, et aucune écriture. Mesuré le 05/10/2026 sur les cinq
 * machines : 1,1 à 1,7 s par serveur, tout en lecture de `/proc` et un `df`. C'est assez
 * peu pour être redemandé à volonté, et c'est pourquoi rien n'est mis en cache côté
 * serveur au-delà de quelques secondes.
 *
 * CE QUI A ÉTÉ MESURÉ, ET QUI A DÉCIDÉ DES SEUILS :
 *
 *   - LES MONTAGES « snap » SONT À 100 % EN PERMANENCE. Ce sont des images en lecture
 *     seule : un écran qui les compterait annoncerait « disque plein » tous les jours de
 *     l'année, et plus personne ne le regarderait. Ils sont écartés, comme `tmpfs`,
 *     `overlay` et `devtmpfs` ;
 *   - les vraies partitions du parc tiennent entre 63 % et 87 % d'occupation. Un seuil
 *     d'alerte à 85 % en signalerait trois sur cinq sans qu'il y ait urgence : 87 % d'une
 *     partition de 207 Go laisse 28 Go libres. Le verdict regarde donc le POURCENTAGE
 *     ET L'ESPACE LIBRE RÉEL, et il faut les deux pour alerter ;
 *   - les inodes ne sont pas un détail ici : 28 177 sites de ~559 fichiers chacun font
 *     des millions d'entrées. Mesuré 23 à 24 % sur `/data/www` — confortable, mais c'est
 *     une limite qu'un disque peut atteindre en ayant encore des octets libres ;
 *   - LE CACHE DE PAGE EST L'INDICATEUR LE PLUS PARLANT DE CE PARC. Une machine saine
 *     garde 7 à 10 Go de fichiers en mémoire ; vps-003, en crise, était tombé à 1,4 Go.
 *     C'est cela qui explique une pression disque de 99,7 % : sans cache, chaque page
 *     repart lire le disque ;
 *   - les processus en attente de disque (état « D ») signent la même crise : 1 sur une
 *     machine saine, 427 sur celle qui souffrait.
 */

/** Ce qui n'est pas un vrai disque, et ne doit donc pas peser dans le verdict. */
const FAUX_DISQUES = /^(tmpfs|devtmpfs|overlay|squashfs|fuse\.snapfuse|ramfs|cgroup|proc|sysfs|autofs|nsfs|efivarfs)$/i;

/** Les points de montage qu'on ne surveille pas, même sur un vrai système de fichiers. */
const HORS_SUJET = /^\/(snap|boot\/efi)(\/|$)/;

/** Occupation à partir de laquelle on alerte, SI l'espace libre est aussi faible. */
export const DISQUE_ALERTE = 90;
export const DISQUE_CRITIQUE = 95;

/** Espace libre en dessous duquel on alerte, quelle que soit l'occupation. */
export const LIBRE_ALERTE = 5 * 1024 ** 3;
export const LIBRE_CRITIQUE = 2 * 1024 ** 3;

/** Charge par cœur : au-delà, la machine sert mal. Mesuré : 0,3 à 0,7 au repos. */
export const CHARGE_ALERTE = 2;
export const CHARGE_CRITIQUE = 4;

/** Pression (disque ou mémoire) en pourcentage du temps. Mesuré : 0,2 à 5 sain, 99,7 en crise. */
export const PRESSION_ALERTE = 25;
export const PRESSION_CRITIQUE = 50;

/** Mémoire disponible, en pourcentage du total. */
export const MEMOIRE_ALERTE = 15;
export const MEMOIRE_CRITIQUE = 8;

/** Part du cache de page dans la mémoire totale. Mesuré : 31 à 43 % sain, 6 % en crise. */
export const CACHE_ALERTE = 15;
export const CACHE_CRITIQUE = 8;

/** Processus bloqués en attente de disque. Mesuré : 1 à 10 sain, 427 en crise. */
export const BLOQUES_ALERTE = 40;
export const BLOQUES_CRITIQUE = 150;

/**
 * La commande. Des repères `#SECTION` séparent les réponses : une sortie en plusieurs
 * morceaux se relit sans deviner, et une section absente ne décale pas les autres.
 */
export function stateCommand({ wwwRoot = null } = {}) {
  const lignes = [
    "echo '#LOAD'",
    'cat /proc/loadavg',
    'nproc',
    "echo '#IO'",
    "awk '/^some/{print $2; exit}' /proc/pressure/io 2>/dev/null || echo avg10=0",
    "echo '#MEMPRESS'",
    "awk '/^some/{print $2; exit}' /proc/pressure/memory 2>/dev/null || echo avg10=0",
    "echo '#MEM'",
    'grep -E "^(MemTotal|MemAvailable|Cached|SwapTotal|SwapFree):" /proc/meminfo',
    "echo '#DF'",
    // `-P` fixe le format sur une ligne par système de fichiers, `-T` donne le type qui
    // permet d'écarter les faux disques, `-B1` donne des octets et non des blocs.
    'df -PTB1 2>/dev/null || true',
    "echo '#INODES'",
    'df -PTi 2>/dev/null || true',
    "echo '#UPTIME'",
    'cut -d. -f1 /proc/uptime',
    "echo '#PROCS'",
    'pgrep -c nginx 2>/dev/null || echo 0',
    'pgrep -c php-fpm 2>/dev/null || echo 0',
    // Les processus en attente de disque : l'indicateur le plus franc d'une crise ici.
    "ps -eo stat= 2>/dev/null | cut -c1 | grep -c D || echo 0",
    "echo '#LISTEN'",
    // LE « echo » FINAL N'EST PAS DÉCORATIF. `tr` ne laisse pas de retour à la ligne, si
    // bien que le repère suivant se collait à la fin de cette ligne : la section d'après
    // disparaissait sans un mot. C'était le cas de `#SITES`.
    "(ss -ltn 2>/dev/null || true) | awk 'NR>1{print $4}' | tr '\\n' ' '; echo",
  ];
  // Le nombre de sites servis : il donne l'échelle de tout le reste. On ne compte que ce
  // qui ressemble à un domaine — la racine contient aussi des dossiers de service.
  if (wwwRoot) {
    lignes.push("echo '#SITES'", `ls -1 ${shq(wwwRoot)} 2>/dev/null | grep -cE '^[a-z0-9][a-z0-9.-]*\\.[a-z]{2,}$' || echo 0`);
  }
  lignes.push("echo '#END'");
  return lignes.join('\n');
}

/** Découpe la sortie sur les repères `#SECTION`. */
function sections(stdout) {
  const out = new Map();
  let nom = null;
  for (const brut of String(stdout ?? '').split('\n')) {
    const l = brut.replace(/\r/g, '');
    if (l.startsWith('#')) {
      nom = l.slice(1).trim();
      out.set(nom, []);
      continue;
    }
    if (nom && l.trim()) out.get(nom).push(l);
  }
  return out;
}

const nombre = (v) => {
  const n = Number(String(v ?? '').replace(/avg10=/, ''));
  return Number.isFinite(n) ? n : 0;
};

/**
 * Une ligne de `df -PT` : système, type, total, utilisé, libre, %, point de montage.
 *
 * Le point de montage peut contenir des espaces ; c'est le dernier champ, et les six
 * premiers sont sûrs. On recompose donc la fin plutôt que de découper aveuglément.
 */
function ligneDf(l) {
  const p = l.trim().split(/\s+/);
  if (p.length < 7) return null;
  const [fs, type, total, used, avail, pct, ...reste] = p;
  if (!/^\d+$/.test(total)) return null; // l'en-tête
  return {
    fs,
    type,
    total: Number(total),
    used: Number(used),
    avail: Number(avail),
    percent: Number(String(pct).replace('%', '')) || 0,
    mount: reste.join(' '),
  };
}

/** Ce qui compte comme un vrai disque qu'on surveille. */
export const disqueSurveille = (d) => d && !FAUX_DISQUES.test(d.type) && !HORS_SUJET.test(d.mount) && d.total > 0;

/** Le pire des deux verdicts. L'ordre est voulu : `critical` gagne toujours. */
const pire = (a, b) => (a === 'critical' || b === 'critical' ? 'critical' : a === 'warn' || b === 'warn' ? 'warn' : 'ok');

/**
 * Un contrôle : sa valeur, son verdict, et de quoi l'écran a besoin pour l'afficher.
 *
 * `value` reste brute (octets, pourcentage, nombre) : c'est l'écran qui met en forme, dans
 * la langue et le fuseau de l'agent.
 */
const controle = (key, state, value, extra = {}) => ({ key, state, value, ...extra });

/**
 * LE DISQUE, et pourquoi il faut DEUX conditions.
 *
 * 87 % d'une partition de 207 Go laisse 28 Go libres : ce n'est pas une urgence. 87 %
 * d'une partition de 20 Go en laisse 2,6 : ça l'est. Alerter sur le seul pourcentage
 * aurait signalé trois machines sur cinq du parc, tous les jours, pour rien.
 */
export function verdictDisque(d) {
  if (d.percent >= DISQUE_CRITIQUE && d.avail < LIBRE_CRITIQUE) return 'critical';
  if (d.avail < LIBRE_CRITIQUE) return 'critical';
  if (d.percent >= DISQUE_ALERTE && d.avail < LIBRE_ALERTE) return 'warn';
  if (d.percent >= DISQUE_CRITIQUE) return 'warn';
  return 'ok';
}

/** Les inodes se jugent sur le seul pourcentage : il n'y a pas d'« espace libre » en octets. */
export function verdictInodes(pct) {
  if (pct >= DISQUE_CRITIQUE) return 'critical';
  if (pct >= DISQUE_ALERTE) return 'warn';
  return 'ok';
}

const seuil = (v, alerte, critique) => (v >= critique ? 'critical' : v >= alerte ? 'warn' : 'ok');
const seuilBas = (v, alerte, critique) => (v <= critique ? 'critical' : v <= alerte ? 'warn' : 'ok');

/** Lit la sortie de la commande et rend l'état complet, verdicts compris. */
export function parseState(stdout) {
  const s = sections(stdout);
  const load = (s.get('LOAD')?.[0] ?? '').trim().split(/\s+/);
  const cores = Number(s.get('LOAD')?.[1]) || 1;
  const parCoeur = (Number(load[0]) || 0) / cores;

  const mem = {};
  for (const l of s.get('MEM') ?? []) {
    const m = /^(\w+):\s+(\d+)/.exec(l.trim());
    if (m) mem[m[1]] = Number(m[2]) * 1024;
  }
  const memTotal = mem.MemTotal ?? 0;
  const dispoPct = memTotal ? ((mem.MemAvailable ?? 0) / memTotal) * 100 : 100;
  const cachePct = memTotal ? ((mem.Cached ?? 0) / memTotal) * 100 : 0;
  const swapUtil = mem.SwapTotal ? ((mem.SwapTotal - (mem.SwapFree ?? 0)) / mem.SwapTotal) * 100 : 0;

  const disques = (s.get('DF') ?? []).map(ligneDf).filter(disqueSurveille);
  const inodes = new Map();
  for (const l of s.get('INODES') ?? []) {
    const d = ligneDf(l);
    if (disqueSurveille(d)) inodes.set(d.mount, d);
  }

  const procs = s.get('PROCS') ?? [];
  const nginx = Number(procs[0]) || 0;
  const fpm = Number(procs[1]) || 0;
  const bloques = Number(procs[2]) || 0;
  const ecoute = (s.get('LISTEN')?.[0] ?? '').trim().split(/\s+/).filter(Boolean);

  const io = nombre(s.get('IO')?.[0]);
  const memPress = nombre(s.get('MEMPRESS')?.[0]);

  const checks = [
    controle('load', seuil(parCoeur, CHARGE_ALERTE, CHARGE_CRITIQUE), Number(load[0]) || 0, { cores, perCore: parCoeur }),
    controle('io', seuil(io, PRESSION_ALERTE, PRESSION_CRITIQUE), io),
    controle('mempress', seuil(memPress, PRESSION_ALERTE, PRESSION_CRITIQUE), memPress),
    controle('memory', seuilBas(dispoPct, MEMOIRE_ALERTE, MEMOIRE_CRITIQUE), dispoPct, { available: mem.MemAvailable ?? 0, total: memTotal }),
    controle('cache', seuilBas(cachePct, CACHE_ALERTE, CACHE_CRITIQUE), cachePct, { bytes: mem.Cached ?? 0 }),
    controle('swap', seuil(swapUtil, 50, 80), swapUtil, { total: mem.SwapTotal ?? 0 }),
    controle('blocked', seuil(bloques, BLOQUES_ALERTE, BLOQUES_CRITIQUE), bloques),
    // nginx arrêté, c'est tout le serveur qui ne répond plus : il n'y a pas de demi-mesure.
    controle('nginx', nginx > 0 ? 'ok' : 'critical', nginx),
    controle('php', fpm > 0 ? 'ok' : 'critical', fpm),
  ];

  for (const d of disques) {
    const i = inodes.get(d.mount);
    checks.push(
      controle('disk', verdictDisque(d), d.percent, { mount: d.mount, total: d.total, used: d.used, avail: d.avail }),
    );
    if (i) checks.push(controle('inodes', verdictInodes(i.percent), i.percent, { mount: i.mount, total: i.total, used: i.used }));
  }

  return {
    state: checks.reduce((acc, c) => pire(acc, c.state), 'ok'),
    uptime: Number(s.get('UPTIME')?.[0]) || 0,
    sites: s.has('SITES') ? Number(s.get('SITES')?.[0]) || 0 : null,
    listening: ecoute,
    checks,
  };
}

export class ServerStateService {
  /** `ttl` : combien de temps une lecture reste valable, pour ne pas la refaire à chaque clic. */
  constructor(ssh, { ttl = 15000 } = {}) {
    this.ssh = ssh;
    this.ttl = ttl;
    this.cache = new Map();
  }

  /**
   * L'état d'un serveur. Lecture seule.
   *
   * Une erreur n'est pas masquée : elle est rendue comme un état `unknown`, parce qu'un
   * serveur dont on ne sait rien n'est pas un serveur qui va bien.
   */
  async one(serverId, { fresh = false } = {}) {
    const vu = this.cache.get(serverId);
    if (!fresh && vu && Date.now() - vu.at < this.ttl) return vu.data;

    const server = this.ssh.server(serverId);
    const base = { server: serverId, label: server.label ?? serverId, host: server.host };
    if (!this.ssh.isConnected(serverId)) {
      return { ...base, state: 'offline', checks: [], uptime: 0, sites: null, listening: [], at: Date.now() };
    }
    try {
      const { stdout } = await this.ssh.exec(serverId, stateCommand({ wwwRoot: server.wwwRoot }), { timeout: 60000 });
      const data = { ...base, ...parseState(stdout), at: Date.now() };
      this.cache.set(serverId, { at: Date.now(), data });
      return data;
    } catch (err) {
      return { ...base, state: 'unknown', error: String(err.key ?? err.message).slice(0, 200), checks: [], uptime: 0, sites: null, listening: [], at: Date.now() };
    }
  }

  /**
   * L'état de plusieurs serveurs, EN PARALLÈLE.
   *
   * Cinq lectures à la suite prendraient huit secondes ; ensemble, moins de deux. Et chacune
   * vit sur sa propre session SSH, donc elles ne s'attendent pas.
   */
  async many(serverIds, opts = {}) {
    return Promise.all([...serverIds].map((id) => this.one(id, opts)));
  }

  /** Oublie ce qui est en cache, pour un serveur ou pour tous. */
  forget(serverId = null) {
    if (serverId) this.cache.delete(serverId);
    else this.cache.clear();
  }
}

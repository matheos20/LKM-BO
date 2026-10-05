import { api } from './api.js';
import { t } from './i18n.js';
import { $, fmtNum, fmtSize, h, icon, toastError } from './ui.js';

/**
 * Écran « État des serveurs ».
 *
 * CE QU'IL DOIT RÉPONDRE EN TROIS SECONDES : laquelle de mes machines va mal, et de quoi
 * souffre-t-elle. L'agent n'est pas administrateur système ; il doit pouvoir dire à qui
 * l'est une phrase juste, sans interpréter des chiffres.
 *
 * D'où l'ordre : les machines les plus en peine en premier, un verdict en mots sur chaque
 * carte, une phrase qui nomme la cause, et seulement ensuite les chiffres. Les seuils sont
 * mesurés et vivent dans `src/services/serverStateService.js`, avec les mesures qui les
 * justifient.
 *
 * TOUT EST EN LECTURE SEULE. Aucun bouton de cet écran ne touche aux machines : la seule
 * action possible est de redemander l'état.
 */

/** Du plus urgent au plus tranquille : c'est l'ordre d'affichage des cartes. */
const RANG = { critical: 0, warn: 1, unknown: 2, offline: 3, ok: 4 };

/** Classes écrites en entier : Tailwind lit ce fichier pour produire sa feuille. */
const PASTILLE = {
  ok: 'bg-accent-50 text-accent-700',
  warn: 'bg-amber-100 text-amber-800',
  critical: 'bg-red-100 text-red-700',
  offline: 'bg-ink-100 text-ink-500',
  unknown: 'bg-ink-100 text-ink-500',
};

const POINT = {
  ok: 'bg-accent-600',
  warn: 'bg-amber-500',
  critical: 'bg-red-600',
  offline: 'bg-ink-300',
  unknown: 'bg-ink-300',
};

/** La barre d'occupation d'un disque : lue d'un coup d'œil, là où « 87 % » se lit en deux. */
const JAUGE = { ok: 'bg-accent-600', warn: 'bg-amber-500', critical: 'bg-red-600' };

const state = {
  open: false,
  servers: [],
  loading: false,
  onClose: null,
};

export const isServerStateOpen = () => state.open;

export async function openServerState({ onClose = null } = {}) {
  state.open = true;
  state.onClose = onClose;
  $('#domains-view').hidden = true;
  $('#health-view').hidden = false;
  render();
  await charger();
}

export function closeServerState() {
  if (!state.open) return;
  state.open = false;
  $('#health-view').hidden = true;
  $('#health-view').replaceChildren();
  $('#domains-view').hidden = false;
  state.onClose?.();
  state.onClose = null;
}

async function charger({ fresh = false } = {}) {
  state.loading = true;
  render();
  try {
    const out = await api(`/api/servers/state${fresh ? '?fresh=1' : ''}`);
    state.servers = (out.servers ?? []).slice().sort((a, b) => (RANG[a.state] ?? 9) - (RANG[b.state] ?? 9) || a.label.localeCompare(b.label));
  } catch (err) {
    toastError(err);
  } finally {
    state.loading = false;
    render();
  }
}

function render() {
  if (!state.open) return;
  $('#page-title').textContent = t('srvstate.title');
  $('#page-sub').classList.remove('font-mono');
  $('#page-sub').textContent = t('srvstate.subtitle');
  $('#page-state').replaceChildren();
  $('#health-view').replaceChildren(barre(), ...(state.servers.length ? state.servers.map(carte) : [vide()]));
}

function vide() {
  return h('p', { class: 'card px-4 py-8 text-center text-sm text-ink-500' }, t(state.loading ? 'srvstate.loading' : 'srvstate.none'));
}

/** Le bandeau du haut : le résumé du parc, et le seul bouton de l'écran. */
function barre() {
  const compte = {};
  for (const s of state.servers) compte[s.state] = (compte[s.state] ?? 0) + 1;
  const malades = (compte.critical ?? 0) + (compte.warn ?? 0);

  return h(
    'div',
    { class: 'card flex flex-wrap items-center gap-x-5 gap-y-3 px-5 py-4' },
    h(
      'p',
      { class: 'flex-1 text-sm' },
      malades
        ? h(
            'span',
            { class: 'font-semibold text-ink' },
            t('srvstate.summary_bad', { bad: fmtNum(malades), total: fmtNum(state.servers.length) }),
          )
        : h(
            'span',
            { class: 'inline-flex items-center gap-2 font-semibold text-accent-700' },
            icon('check'),
            t('srvstate.summary_ok', { total: fmtNum(state.servers.length) }),
          ),
    ),
    h(
      'button',
      {
        type: 'button',
        class: 'btn-outline',
        disabled: state.loading,
        onclick: () => charger({ fresh: true }),
      },
      h('span', { class: 'inline-flex items-center gap-2' }, icon('refresh'), t(state.loading ? 'srvstate.loading' : 'srvstate.refresh')),
    ),
  );
}

/**
 * La phrase qui nomme la cause, et c'est elle qui fait tout le travail.
 *
 * Un agent à qui l'on montre « pression I/O 99,4 % » ne sait pas quoi en faire. La même
 * mesure dite en mots — « cette machine passe son temps à attendre son disque » — se
 * transmet telle quelle à l'administrateur. Les contrôles sont donc traduits en phrases,
 * du plus grave au moins grave, et seuls les deux premiers sont montrés : une liste de
 * six griefs ne se lit pas.
 */
function causes(serveur) {
  const dits = [];
  for (const c of serveur.checks.filter((x) => x.state !== 'ok').sort((a, b) => RANG[a.state] - RANG[b.state])) {
    if (c.key === 'disk') dits.push(t('srvstate.why_disk', { mount: c.mount, percent: Math.round(c.value), free: fmtSize(c.avail) }));
    else if (c.key === 'inodes') dits.push(t('srvstate.why_inodes', { mount: c.mount, percent: Math.round(c.value) }));
    else if (c.key === 'io') dits.push(t('srvstate.why_io', { percent: Math.round(c.value) }));
    else if (c.key === 'mempress') dits.push(t('srvstate.why_mempress', { percent: Math.round(c.value) }));
    else if (c.key === 'load') dits.push(t('srvstate.why_load', { load: dec(c.value, 1), cores: c.cores }));
    else if (c.key === 'memory') dits.push(t('srvstate.why_memory', { percent: Math.round(c.value) }));
    else if (c.key === 'cache') dits.push(t('srvstate.why_cache', { size: fmtSize(c.bytes) }));
    else if (c.key === 'swap') dits.push(t('srvstate.why_swap', { percent: Math.round(c.value) }));
    else if (c.key === 'blocked') dits.push(t('srvstate.why_blocked', { count: fmtNum(c.value) }));
    else if (c.key === 'nginx') dits.push(t('srvstate.why_nginx'));
    else if (c.key === 'php') dits.push(t('srvstate.why_php'));
  }
  return dits.slice(0, 2);
}

/**
 * Un nombre à décimales, dans la langue de l'agent.
 *
 * `toFixed` écrit toujours un point. « 270.57 » fait buter un lecteur français sur un
 * chiffre qu'on veut justement limpide ; `fmtNum` passe par Intl et met la virgule.
 */
const dec = (v, n = 2) => fmtNum(Math.round((Number(v) || 0) * 10 ** n) / 10 ** n);

/** Une durée en jours et heures, dans la langue de l'agent. */
function depuis(secondes) {
  const jours = Math.floor(secondes / 86400);
  const heures = Math.floor((secondes % 86400) / 3600);
  if (jours) return t('srvstate.since_days', { days: fmtNum(jours), hours: String(heures) });
  return t('srvstate.since_hours', { hours: String(heures) });
}

function carte(s) {
  const disques = s.checks.filter((c) => c.key === 'disk');
  const inodes = new Map(s.checks.filter((c) => c.key === 'inodes').map((c) => [c.mount, c]));
  const trouve = (key) => s.checks.find((c) => c.key === key);
  const pourquoi = causes(s);

  return h(
    'section',
    { class: 'card overflow-hidden' },
    h(
      'header',
      { class: 'flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-ink-100 px-5 py-3.5' },
      h('span', { class: `size-2.5 shrink-0 rounded-full ${POINT[s.state]}` }),
      h(
        'span',
        { class: 'min-w-0' },
        h('span', { class: 'block truncate text-sm font-semibold text-ink' }, s.label),
        h('span', { class: 'block truncate font-mono text-[11px] text-ink-400' }, s.host),
      ),
      h('span', { class: `rounded-md px-2 py-0.5 text-xs font-semibold ${PASTILLE[s.state]}` }, t(`srvstate.state_${s.state}`)),
      h('span', { class: 'flex-1' }),
      s.sites != null ? h('span', { class: 'text-xs text-ink-400' }, t('srvstate.sites', { count: fmtNum(s.sites) })) : null,
      s.uptime ? h('span', { class: 'text-xs text-ink-400' }, depuis(s.uptime)) : null,
    ),
    // La cause, en mots : c'est ce que l'agent transmettra à son administrateur.
    pourquoi.length
      ? h(
          'ul',
          { class: `space-y-1 px-5 py-3 text-sm ${s.state === 'critical' ? 'bg-red-50 text-red-900' : 'bg-amber-50 text-amber-900'}` },
          pourquoi.map((p) => h('li', { class: 'flex items-start gap-2' }, icon('alert', 'size-4 shrink-0 mt-0.5'), p)),
        )
      : null,
    s.error ? h('p', { class: 'bg-ink-50 px-5 py-3 text-sm text-ink-500' }, s.error) : null,
    s.state === 'offline' ? h('p', { class: 'bg-ink-50 px-5 py-3 text-sm text-ink-500' }, t('srvstate.offline_hint')) : null,

    s.checks.length
      ? h(
          'div',
          { class: 'grid gap-5 px-5 py-4 lg:grid-cols-2' },
          h(
            'div',
            { class: 'space-y-3' },
            titre(t('srvstate.group_disk')),
            ...disques.map((d) => jaugeDisque(d, inodes.get(d.mount))),
          ),
          h(
            'div',
            { class: 'space-y-3' },
            titre(t('srvstate.group_machine')),
            lignes([
              ligneChiffre(trouve('load'), t('srvstate.load'), (c) => t('srvstate.load_value', { load: dec(c.value), cores: c.cores, perCore: dec(c.perCore) })),
              ligneChiffre(trouve('io'), t('srvstate.io'), (c) => `${Math.round(c.value)} %`),
              ligneChiffre(trouve('memory'), t('srvstate.memory'), (c) => `${Math.round(c.value)} % · ${fmtSize(c.available)}`),
              // Le cache de page explique la pression disque mieux que tout le reste sur ce
              // parc : une machine saine en garde 7 à 10 Go, celle qui souffrait 2.
              ligneChiffre(trouve('cache'), t('srvstate.cache'), (c) => fmtSize(c.bytes)),
              ligneChiffre(trouve('swap'), t('srvstate.swap'), (c) => `${Math.round(c.value)} %`),
              ligneChiffre(trouve('blocked'), t('srvstate.blocked'), (c) => fmtNum(c.value)),
              ligneChiffre(trouve('nginx'), t('srvstate.nginx'), (c) => (c.value ? t('srvstate.running', { count: fmtNum(c.value) }) : t('srvstate.stopped'))),
              ligneChiffre(trouve('php'), t('srvstate.php'), (c) => (c.value ? t('srvstate.running', { count: fmtNum(c.value) }) : t('srvstate.stopped'))),
            ]),
          ),
        )
      : null,
  );
}

const titre = (texte) => h('p', { class: 'text-xs font-semibold tracking-wide text-ink-400 uppercase' }, texte);

const lignes = (items) => h('dl', { class: 'space-y-1.5' }, items.filter(Boolean));

function ligneChiffre(c, label, format) {
  if (!c) return null;
  const tons = { ok: 'text-ink', warn: 'text-amber-700', critical: 'text-red-700' };
  return h(
    'div',
    { class: 'flex items-baseline justify-between gap-3 text-sm' },
    h('dt', { class: 'text-ink-500' }, label),
    h('dd', { class: `tabular-nums ${tons[c.state] ?? 'text-ink'}` }, format(c)),
  );
}

/**
 * Un disque : sa barre, son occupation, et l'espace qui reste EN OCTETS.
 *
 * Les deux vont ensemble, et c'est volontaire : 87 % d'une partition de 193 Go laisse
 * 27 Go, ce qui est confortable ; 87 % d'une partition de 20 Go n'est pas la même nouvelle.
 * Le pourcentage seul ferait paniquer pour rien — le parc vit entre 63 et 87 %.
 */
function jaugeDisque(d, i) {
  const pct = Math.min(100, Math.max(0, Math.round(d.value)));
  return h(
    'div',
    {},
    h(
      'div',
      { class: 'flex items-baseline justify-between gap-3 text-sm' },
      h('span', { class: 'truncate font-mono text-xs text-ink' }, d.mount),
      h(
        'span',
        { class: `tabular-nums ${d.state === 'critical' ? 'text-red-700' : d.state === 'warn' ? 'text-amber-700' : 'text-ink-500'}` },
        t('srvstate.disk_value', { percent: pct, free: fmtSize(d.avail), total: fmtSize(d.total) }),
      ),
    ),
    h(
      'div',
      { class: 'mt-1 h-1.5 w-full overflow-hidden rounded-full bg-ink-100', role: 'img', 'aria-label': `${d.mount} ${pct} %` },
      h('div', { class: `h-full rounded-full ${JAUGE[d.state] ?? JAUGE.ok}`, style: `width:${pct}%` }),
    ),
    i
      ? h(
          'p',
          { class: `mt-1 text-xs ${i.state === 'ok' ? 'text-ink-400' : 'text-amber-700'}` },
          t('srvstate.inodes_value', { percent: Math.round(i.value), used: fmtNum(i.used), total: fmtNum(i.total) }),
        )
      : null,
  );
}

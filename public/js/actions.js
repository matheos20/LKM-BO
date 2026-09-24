import { api } from './api.js';
import { t } from './i18n.js';
import { $, enc, fmtNum, folderButton, h, icon, stepTitle, toast, toastError } from './ui.js';
import { categoryAction } from './categories.js';
import { templateAction } from './templates.js';
import { translateAction } from './translate.js';

/**
 * Écran « Actions » : les traitements de masse du parc.
 *
 * L'écran ne connaît aucun traitement en particulier. Il apporte ce qui leur est
 * commun — choisir l'action, choisir les sites, avancer par lots, montrer où l'on en
 * est — et laisse chaque action rendre ses propres résultats. Ajouter un traitement
 * demain, c'est ajouter une entrée dans ACTIONS.
 *
 * Trois périmètres, parce que les trois besoins existent :
 *   - TOUT LE SERVEUR : la tournée de fond, sur les milliers de sites d'un VPS ;
 *   - TOUT LE PARC : la même chose sur tous les serveurs connectés, d'une traite ;
 *   - UNE LISTE DE DOMAINES : ceux qu'un agent colle depuis un tableur. Ils peuvent
 *     venir de plusieurs serveurs à la fois : le back-office les répartit lui-même,
 *     et dit clairement lesquels il ne trouve pas, et pourquoi.
 */

/**
 * Traitements disponibles.
 *
 * Une action fournit au minimum { key, icon, labelKey, hintKey, batch, reset, run,
 * stats, results }. Trois ajouts facultatifs lui permettent de demander autre chose
 * que « lance-toi sur ces sites » :
 *
 *   form()      une carte de saisie, affichée avant le périmètre — les rubriques à
 *               créer, par exemple ;
 *   targets()   sa propre liste de sites, quand la saisie les désigne déjà (un tableau
 *               collé) ; le périmètre de l'écran s'efface alors ;
 *   canRun()    false tant que la saisie est incomplète — le bouton reste inerte.
 */
const ACTIONS = [translateAction, templateAction, categoryAction];

const state = {
  open: false,
  action: ACTIONS[0],
  serverId: null,
  serverLabel: '',
  servers: [],
  permissions: [],
  domains: [], // domaines du serveur courant (périmètre « tout le serveur »)
  loadingDomains: false,
  scope: 'server', // server | parc | list
  parc: null, // serveur → noms de domaines, pour le périmètre « tout le parc »
  parcChoisis: new Set(), // sous-ensemble retenu par l'agent
  loadingParc: false,
  text: '',
  resolved: null, // { found:[{domain,server}], unknown:[], offline:[] }
  resolving: false,
  phase: 'idle', // idle | running | done
  total: 0,
  done: 0,
  cancel: false,
  suspended: false, // écran mis de côté le temps d'un détour par les fichiers
  onClose: null,
};

export const isActionsOpen = () => state.open;
export const rerenderActions = () => state.open && render();

const serverLabel = (id) => state.servers.find((s) => s.id === id)?.label ?? id;

export async function openActions({ serverId, serverLabel: label, servers, permissions, onClose }) {
  const serveurPrecedent = state.serverId;
  Object.assign(state, {
    open: true,
    action: ACTIONS[0],
    serverId: serverId && serverId !== 'all' ? serverId : null,
    serverLabel: label ?? serverId ?? '',
    servers: servers ?? [],
    permissions: permissions ?? [],
    domains: [],
    loadingDomains: false,
    parc: null,
    parcChoisis: new Set(),
    loadingParc: false,
    scope: serverId && serverId !== 'all' ? 'server' : 'parc',
    text: '',
    resolved: null,
    resolving: false,
    total: 0,
    done: 0,
    cancel: false,
    onClose,
  });
  if (listArea) listArea.value = '';
  for (const action of ACTIONS) action.onChange = render;
  // Les résultats d'une analyse survivent à une sortie d'écran : un relevé sur des
  // milliers de sites ne doit pas disparaître parce qu'on est allé voir un fichier.
  // Changer de serveur, en revanche, ouvre un autre sujet : on repart à zéro.
  if (serveurPrecedent !== state.serverId) for (const action of ACTIONS) action.reset();
  state.phase = state.action.ready?.() ? 'done' : 'idle';

  $('#domains-view').hidden = true;
  $('#files-view').hidden = true;
  $('#admin-view').hidden = true;
  $('#design-view').hidden = true;
  $('#actions-view').hidden = false;
  $('#btn-back').hidden = false;
  for (const sel of ['#btn-conn', '#btn-refresh', '#btn-add']) $(sel).hidden = true;

  render();
  await (state.scope === 'parc' ? loadParcDomains() : loadServerDomains());
}

/**
 * Met l'écran de côté pour en ouvrir un autre — le gestionnaire de fichiers — et le
 * reprend ensuite tel quel. Sans cela, aller regarder un fichier ferait perdre une
 * analyse qui a pu coûter plusieurs minutes.
 */
export const isActionsSuspended = () => state.open && state.suspended;

function suspendActions() {
  state.suspended = true;
  $('#actions-view').hidden = true;
}

function resumeActions() {
  if (!state.open) return;
  state.suspended = false;
  $('#domains-view').hidden = true;
  $('#files-view').hidden = true;
  $('#actions-view').hidden = false;
  $('#btn-back').hidden = false;
  for (const sel of ['#btn-conn', '#btn-refresh', '#btn-add']) $(sel).hidden = true;
  render();
}

/**
 * Ouvre le gestionnaire de fichiers sur le domaine, et revient ici en le fermant.
 * Le module est chargé à la demande : il s'installe des écouteurs sur le document,
 * ce qui empêcherait de charger cet écran-ci hors d'un navigateur (les tests).
 */
async function openFilesFor(site) {
  const { openFiles } = await import('./files.js');
  suspendActions();
  openFiles({
    serverId: site.server,
    serverLabel: serverLabel(site.server),
    domain: site.domain,
    status: site.lock?.status ?? null,
    onClose: resumeActions,
  });
}

export function closeActions() {
  if (!state.open) return;
  state.open = false;
  state.suspended = false;
  state.cancel = true;
  $('#actions-view').hidden = true;
  $('#actions-view').replaceChildren();
  $('#domains-view').hidden = false;
  $('#btn-back').hidden = true;
  for (const sel of ['#btn-refresh', '#btn-add']) $(sel).hidden = false;
  state.onClose?.();
}

/** Liste complète des domaines du serveur : le tableau n'en montre qu'une page. */
async function loadServerDomains() {
  if (!state.serverId) return;
  state.loadingDomains = true;
  render();
  try {
    const { domains } = await api(`/api/servers/${enc(state.serverId)}/domain-names`);
    state.domains = domains ?? [];
  } catch (err) {
    toastError(err);
  } finally {
    state.loadingDomains = false;
    render();
  }
}

/**
 * Les domaines de TOUS les serveurs connectés.
 *
 * C'est la tournée de fond du parc : près de 28 000 sites, soit quelques minutes
 * d'analyse. Les serveurs déconnectés sont simplement absents — et dits comme tels,
 * car c'est la première raison pour laquelle un domaine manquerait à l'appel.
 */
async function loadParcDomains() {
  if (state.parc || state.loadingParc) return;
  const connectes = state.servers.filter((s) => s.state === 'connected');
  if (!connectes.length) return;

  state.loadingParc = true;
  render();
  const parc = new Map();
  const res = await Promise.allSettled(connectes.map((s) => api(`/api/servers/${enc(s.id)}/domain-names`)));
  res.forEach((r, i) => {
    if (r.status === 'fulfilled') parc.set(connectes[i].id, r.value.domains ?? []);
  });
  state.parc = parc;
  state.parcChoisis = new Set(parc.keys());
  state.loadingParc = false;
  render();
}

/** Serveurs que l'agent ne peut pas interroger : rien ne marchera sans eux. */
const serveursHorsLigne = () => state.servers.filter((s) => s.state !== 'connected');

/**
 * Reconnecte les serveurs depuis cet écran.
 *
 * Sans cela, l'agent voyait « domaine introuvable » et cherchait une faute de frappe
 * dans son fichier, alors que la seule chose à faire était de rouvrir les sessions.
 */
async function connecterTout(bouton) {
  const hors = serveursHorsLigne();
  if (!hors.length) return;
  if (bouton) bouton.disabled = true;
  try {
    await Promise.all(hors.map((s) => api(`/api/servers/${enc(s.id)}/connect`, { method: 'POST' }).catch(() => null)));
    const { servers } = await api('/api/servers');
    state.servers = servers ?? state.servers;
    const restants = serveursHorsLigne();
    if (restants.length) toast(t('actions.connect_partial', { servers: restants.map((s) => s.label).join(', ') }), 'info');
    else toast(t('actions.connect_done'), 'success');
    // Ce qui avait échoué faute de serveurs mérite une seconde chance.
    state.parc = null;
    if (state.scope === 'parc') await loadParcDomains();
    else if (state.scope === 'server') await loadServerDomains();
    if (state.text.trim()) await resolveList();
  } catch (err) {
    toastError(err);
  } finally {
    if (bouton) bouton.disabled = false;
    render();
  }
}

/** Bandeau franc, en haut de l'écran : la cause, et le geste qui la répare. */
function bandeauConnexion() {
  const hors = serveursHorsLigne();
  if (!hors.length) return null;
  const bouton = h('button', { type: 'button', class: 'btn btn-dark px-3 py-1.5 text-xs' }, icon('plug', 'size-3.5'), t('server.connect_all'));
  bouton.addEventListener('click', () => connecterTout(bouton));

  return h(
    'div',
    { class: 'card flex flex-wrap items-center gap-3 border-l-4 border-l-amber-400 px-5 py-3' },
    icon('alert', 'size-5 shrink-0 text-amber-600'),
    h(
      'div',
      { class: 'min-w-0 flex-1' },
      h('p', { class: 'text-sm font-medium text-ink' }, t('actions.offline_title', { count: fmtNum(hors.length) })),
      h('p', { class: 'mt-0.5 text-xs text-ink-500' }, t('actions.offline_body', { servers: hors.map((s) => s.label).join(', ') })),
    ),
    bouton,
  );
}

// ───────────────────────── Périmètre ─────────────────────────

/** Une liste collée depuis un tableur : séparateurs libres, adresses complètes tolérées. */
export function parseDomains(text) {
  return [
    ...new Set(
      String(text ?? '')
        .split(/[\s,;|]+/)
        .map((raw) =>
          raw
            .trim()
            .toLowerCase()
            .replace(/^https?:\/\//, '')
            .replace(/^www\./, '')
            .replace(/[/?#].*$/, '')
            .replace(/[.,;]+$/, ''),
        )
        .filter((d) => /^[a-z0-9][a-z0-9.-]{1,252}$/.test(d) && d.includes('.')),
    ),
  ];
}

let resolveTimer = null;
function scheduleResolve() {
  clearTimeout(resolveTimer);
  resolveTimer = setTimeout(resolveList, 400);
}

async function resolveList() {
  const domains = parseDomains(state.text);
  if (!domains.length) {
    state.resolved = null;
    return render();
  }
  state.resolving = true;
  render();
  try {
    state.resolved = await api('/api/domains/resolve', { method: 'POST', body: { domains } });
  } catch (err) {
    state.resolved = null;
    toastError(err);
  } finally {
    state.resolving = false;
    render();
  }
}

/** Cibles retenues, dans l'ordre, chacune avec le serveur qui la porte. */
function targets() {
  // Une action dont la saisie désigne déjà les sites passe avant le périmètre.
  const propres = state.action.targets?.();
  if (propres) return propres;
  if (state.scope === 'list') return state.resolved?.found ?? [];
  if (state.scope === 'parc') {
    const out = [];
    for (const [server, noms] of state.parc ?? []) {
      if (!state.parcChoisis.has(server)) continue;
      for (const domain of noms) out.push({ domain, server });
    }
    return out;
  }
  return state.domains.map((domain) => ({ domain, server: state.serverId }));
}

// ───────────────────────── Exécution ─────────────────────────

async function run() {
  const list = targets();
  if (!list.length) return toast(t('actions.no_target'), 'info');

  const action = state.action;
  action.reset();
  Object.assign(state, { phase: 'running', total: list.length, done: 0, cancel: false });
  render();

  // Un lot ne mélange jamais deux serveurs : chaque appel s'adresse à une machine.
  const size = action.batch ?? 100;
  const groups = new Map();
  for (const target of list) {
    if (!groups.has(target.server)) groups.set(target.server, []);
    groups.get(target.server).push(target.domain);
  }

  // Une coupure sur un serveur ne doit pas emporter le travail des autres : le parc
  // entier demande une dizaine de minutes, et une session SSH peut tomber en route.
  const echecs = [];
  for (const [server, domains] of groups) {
    for (let i = 0; i < domains.length; i += size) {
      if (state.cancel || !state.open) break;
      const batch = domains.slice(i, i + size);
      try {
        await action.run(server, batch, { permissions: state.permissions });
        // Les résultats portent un identifiant de serveur ; l'écran seul connaît son nom.
        action.labelServers?.(serverLabel);
        state.done += batch.length;
      } catch (err) {
        echecs.push({ server, message: err.message });
        // Le reste de CE serveur est perdu ; la progression en tient compte.
        state.done += domains.length - i;
        render();
        break;
      }
      render();
    }
    if (state.cancel || !state.open) break;
  }

  state.phase = 'done';
  render();
  for (const e of echecs) toast(t('actions.server_failed', { server: serverLabel(e.server) }), 'error', e.message);
  if (!state.cancel && echecs.length < groups.size) action.finished?.();
}

// ───────────────────────── Rendu ─────────────────────────

function render() {
  if (!state.open) return;
  $('#page-title').textContent = t('actions.title');
  $('#page-sub').classList.remove('font-mono');
  $('#page-sub').textContent = state.serverId ? state.serverLabel : t('actions.all_servers');
  $('#page-state').replaceChildren();

  // Les étapes se numérotent toutes seules : une action sans formulaire commence au
  // choix des sites. L'agent suit 1, 2, 3 sans qu'on lui explique.
  const avecForm = Boolean(state.action.form);
  const etape = { form: 1, scope: avecForm ? 2 : 1, results: avecForm ? 3 : 2 };
  const results = state.action.results({ permissions: state.permissions, openFiles: openFilesFor });
  const vide = !results && state.phase === 'done' ? state.action.emptyState?.() : null;
  // Le formulaire a besoin des sites : supprimer une rubrique suppose de savoir
  // lesquelles sont en place, et cela se lit sur les sites choisis.
  const formulaire = state.action.form?.({ permissions: state.permissions, step: etape.form, targets: targets() });
  const perimetre = scopeCard(etape.scope);

  const body = [
    chooser(),
    bandeauConnexion(),
    // Deux saisies courtes valent mieux côte à côte : l'écran tenait sur trois cartes
    // empilées, avec un vide au milieu et le bouton perdu en bas.
    formulaire
      ? (formulaire.classList.add('xl:col-span-2'),
        h('div', { class: 'grid items-start gap-4 xl:grid-cols-3' }, formulaire, perimetre))
      : perimetre,
    runBar(),
    statsRow(),
    // En-tête de section plutôt qu'une carte : la vérification n'est pas une saisie.
    results || vide ? h('div', { class: 'px-1 pt-2' }, stepTitle(etape.results, t('actions.step_result'), t('actions.step_result_hint'))) : null,
    results ?? vide,
  ];
  $('#actions-view').replaceChildren(...body.filter(Boolean));
}

/** Bouton « Action » : une liste déroulante, prête à accueillir les traitements suivants. */
function chooser() {
  const select = h(
    'select',
    {
      class: 'input sm:w-64',
      'aria-label': t('actions.choose'),
      onchange: (e) => {
        state.action = ACTIONS.find((a) => a.key === e.target.value) ?? ACTIONS[0];
        state.phase = 'idle';
        render();
      },
    },
    ACTIONS.map((a) => h('option', { value: a.key, selected: a.key === state.action.key }, t(a.labelKey))),
  );

  return h(
    'div',
    { class: 'card flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3' },
    h('span', { class: 'flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-50 text-accent-700' }, icon(state.action.icon, 'size-5')),
    h('p', { class: 'text-xs font-semibold tracking-wide text-ink-400 uppercase' }, t('actions.choose')),
    select,
    h('p', { class: 'min-w-0 flex-1 basis-80 text-sm text-ink-500' }, t(state.action.hintKey)),
  );
}

function scopeCard(numero) {
  const tab = (key, label, disabled) =>
    h(
      'button',
      {
        type: 'button',
        class: 'seg',
        'aria-pressed': String(state.scope === key),
        disabled,
        title: disabled ? t('actions.pick_server_first') : null,
        onclick: () => {
          state.scope = key;
          if (key === 'parc') loadParcDomains();
          render();
        },
      },
      label,
    );

  const running = state.phase === 'running';
  const count = targets().length;
  const sitesFournis = Boolean(state.action.targets?.());

  return h(
    'div',
    { class: 'card p-5' },
    sitesFournis
      ? stepTitle(numero, t('actions.scope'), t('actions.scope_from_form'))
      : h(
          'div',
          { class: 'flex flex-wrap items-center gap-3' },
          h('div', { class: 'flex-1' }, stepTitle(numero, t('actions.scope'))),
          h(
            'div',
            { class: 'flex rounded-lg bg-ink-50 p-1' },
            tab('server', t('actions.scope_server'), !state.serverId || running),
            tab('parc', t('actions.scope_parc'), running),
            tab('list', t('actions.scope_list'), running),
          ),
        ),
    sitesFournis ? null : state.scope === 'server' ? serverScope() : state.scope === 'parc' ? parcScope() : listScope(),
  );
}

/**
 * Le ruban de lancement, sur toute la largeur.
 *
 * Il était au coin d'une carte, sous la saisie : on ne le trouvait pas. Seul sur sa
 * ligne, il dit ce qui est retenu, ce qui va se passer, et porte le seul bouton vert
 * de l'écran.
 */
function runBar() {
  const running = state.phase === 'running';
  const count = targets().length;
  const pret = count > 0 && state.action.canRun?.() !== false;

  return h(
    'div',
    { class: 'card px-5 py-4' },
    h(
      'div',
      { class: 'flex flex-wrap items-center gap-4' },
      h(
        'div',
        { class: 'min-w-0 flex-1' },
        h(
          'p',
          { class: pret ? 'text-sm font-medium text-ink' : 'text-sm text-ink-400' },
          t('actions.selected', { count: fmtNum(count) }),
        ),
        state.phase === 'idle'
          ? h('p', { class: 'mt-0.5 text-xs text-ink-400' }, t(state.action.beforeRunKey ?? 'actions.before_run'))
          : null,
      ),
      running
        ? h('button', { type: 'button', class: 'btn btn-outline', onclick: () => { state.cancel = true; } }, t('actions.stop'))
        : h(
            'button',
            {
              type: 'button',
              class: 'btn btn-primary px-5 py-2.5',
              disabled: !pret,
              onclick: run,
            },
            icon('refresh'),
            // Une action qui nomme son bouton garde son mot à toutes les étapes :
            // « Relancer » après une vérification se confondrait avec la création.
            t(state.action.startLabelKey ?? (state.phase === 'done' ? 'actions.restart' : 'actions.start')),
          ),
    ),
    running ? progress() : null,
  );
}

function serverScope() {
  if (!state.serverId) return h('p', { class: 'mt-3 text-sm text-ink-500' }, t('actions.pick_server_first'));
  return h(
    'p',
    { class: 'mt-3 text-sm text-ink-500' },
    state.loadingDomains
      ? t('files.loading')
      : t('actions.server_scope_hint', { server: state.serverLabel, count: fmtNum(state.domains.length) }),
  );
}

/**
 * La zone de saisie survit aux rafraîchissements.
 *
 * L'écran se redessine à chaque lot analysé et à chaque recherche de domaines ; un
 * champ reconstruit perdrait le curseur au milieu d'une frappe. Le même élément est
 * donc conservé d'un rendu à l'autre, son contenu vivant dans `state.text`.
 */
let listArea = null;
function listInput() {
  listArea ??= h('textarea', {
    class: 'input font-mono text-xs leading-5',
    rows: '5',
    spellcheck: 'false',
    placeholder: 'caswellscoffee.com\ndinemec.com\nmandyscarr.com',
    oninput: (e) => {
      state.text = e.target.value;
      scheduleResolve();
    },
  });
  listArea.disabled = state.phase === 'running';
  return listArea;
}

/**
 * Une pastille par serveur, à cocher ou décocher.
 *
 * Le parc entier demande une dizaine de minutes ; un agent veut souvent traiter un
 * serveur à la fois, ou reprendre celui qui reste. Tous sont retenus au départ.
 */
function parcScope() {
  if (state.loadingParc) return h('p', { class: 'mt-3 text-sm text-ink-500' }, t('actions.parc_loading'));

  const running = state.phase === 'running';
  const hors = state.servers.filter((s) => s.state !== 'connected');
  const entrees = [...(state.parc ?? [])];

  const pastille = ([id, noms]) => {
    const retenu = state.parcChoisis.has(id);
    return h(
      'button',
      {
        type: 'button',
        class: `flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition ${
          retenu ? 'border-accent bg-accent-50 text-ink' : 'border-ink-200 bg-white text-ink-400 hover:border-ink-300'
        }`,
        'aria-pressed': String(retenu),
        disabled: running,
        onclick: () => {
          if (retenu) state.parcChoisis.delete(id);
          else state.parcChoisis.add(id);
          render();
        },
      },
      icon(retenu ? 'check' : 'plus', 'size-3.5'),
      h('span', { class: 'font-medium' }, serverLabel(id)),
      h('span', { class: 'tabular-nums text-ink-400' }, fmtNum(noms.length)),
    );
  };

  const tous = state.parcChoisis.size === entrees.length;
  return h(
    'div',
    { class: 'mt-3 space-y-2.5' },
    h('p', { class: 'text-sm text-ink-500' }, t('actions.parc_hint')),
    h(
      'div',
      { class: 'flex flex-wrap items-center gap-2' },
      entrees.map(pastille),
      entrees.length > 1
        ? h(
            'button',
            {
              type: 'button',
              class: 'btn btn-ghost px-2 py-1 text-xs',
              disabled: running,
              onclick: () => {
                state.parcChoisis = tous ? new Set() : new Set(entrees.map(([id]) => id));
                render();
              },
            },
            t(tous ? 'actions.pick_none' : 'actions.pick_all'),
          )
        : null,
    ),
    hors.length ? h('p', { class: 'text-xs text-ink-400' }, t('actions.offline', { servers: hors.map((s) => s.label).join(', ') })) : null,
  );
}

function listScope() {
  const area = listInput();
  const res = state.resolved;
  return h(
    'div',
    { class: 'mt-3 space-y-2' },
    h('p', { class: 'text-sm text-ink-500' }, t('actions.list_hint')),
    area,
    state.resolving ? h('p', { class: 'text-xs text-ink-400' }, t('actions.resolving')) : null,
    res
      ? h(
          'div',
          { class: 'space-y-1.5' },
          res.found.length
            ? h(
                'p',
                { class: 'text-sm text-accent-700' },
                t('actions.found', { count: fmtNum(res.found.length) }),
                ' ',
                h('span', { class: 'text-ink-500' }, byServer(res.found)),
              )
            : null,
          // Chaque domaine reconnu porte son bouton dossier : l'agent peut aller voir
          // les fichiers tout de suite, sans lancer le traitement d'abord. Au-delà
          // d'une poignée, la liste redevient un simple décompte : mille puces ne
          // servent personne, et le décompte par serveur est juste au-dessus.
          res.found.length && res.found.length <= 24 ? pucesDomaines(res.found) : null,
          // Un domaine « introuvable » alors qu'aucun serveur ne répond n'est pas
          // introuvable : il n'a pas été cherché. Le bandeau du haut dit quoi faire.
          res.unknown.length
            ? h(
                'p',
                { class: serveursHorsLigne().length ? 'text-sm text-ink-500' : 'text-sm text-red-600' },
                t(serveursHorsLigne().length ? 'actions.unsearched' : 'actions.unknown', { count: fmtNum(res.unknown.length) }),
                ' ',
                h('span', { class: 'font-mono text-xs' }, res.unknown.slice(0, 8).join(', ')),
                res.unknown.length > 8 ? '…' : '',
              )
            : null,
        )
      : null,
  );
}

/** « 12 sur vps-001, 3 sur vps-003 » : l'agent voit où son travail va se faire. */
/** Un domaine reconnu, son serveur, et le bouton qui ouvre ses fichiers. */
function pucesDomaines(found) {
  return h(
    'div',
    { class: 'flex flex-wrap gap-1.5' },
    found.map((site) =>
      h(
        'span',
        { class: 'inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-white py-0.5 pl-2.5 pr-1 text-xs' },
        h('span', { class: 'font-mono' }, site.domain),
        h('span', { class: 'text-ink-400' }, serverLabel(site.server)),
        folderButton(state.permissions, () => openFilesFor(site), { compact: true }),
      ),
    ),
  );
}

function byServer(found) {
  const counts = new Map();
  for (const f of found) counts.set(f.server, (counts.get(f.server) ?? 0) + 1);
  return [...counts].map(([id, n]) => `${fmtNum(n)} · ${serverLabel(id)}`).join(' — ');
}

function progress() {
  const pct = state.total ? Math.min(100, Math.round((state.done / state.total) * 100)) : 0;
  return h(
    'div',
    { class: 'mt-4' },
    h(
      'div',
      { class: 'mb-1.5 flex items-center justify-between text-xs font-medium text-ink-500' },
      h('span', {}, t('actions.progress', { done: fmtNum(state.done), total: fmtNum(state.total) })),
      h('span', { class: 'tabular-nums' }, `${pct} %`),
    ),
    h(
      'div',
      { class: 'h-2 overflow-hidden rounded-full bg-ink-100', role: 'progressbar', 'aria-valuenow': String(pct), 'aria-valuemin': '0', 'aria-valuemax': '100' },
      h('div', { class: 'h-full rounded-full bg-accent transition-all duration-300', style: `width:${pct}%` }),
    ),
  );
}

// Classes écrites en toutes lettres : Tailwind lit ce fichier pour produire sa feuille,
// et ne verrait pas une classe assemblée à l'exécution.
const GRID = ['lg:grid-cols-3', 'lg:grid-cols-3', 'lg:grid-cols-3', 'lg:grid-cols-4', 'lg:grid-cols-5'];

function statsRow() {
  if (state.phase === 'idle') return null;
  const cells = state.action.stats();
  if (!cells.length) return null;
  return h(
    'div',
    { class: `grid grid-cols-2 gap-3 sm:grid-cols-3 ${GRID[Math.min(cells.length, GRID.length) - 1]}` },
    cells.map(([key, value, tone, hint]) =>
      h(
        'div',
        { class: 'card px-4 py-3', title: hint ? t(hint) : null },
        h('p', { class: 'text-xs font-medium tracking-wide text-ink-400 uppercase' }, t(key)),
        h('p', { class: `mt-1 text-2xl font-bold tabular-nums ${tone ?? 'text-ink'}` }, value),
      ),
    ),
  );
}

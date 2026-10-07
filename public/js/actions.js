import { api } from './api.js';
import { t } from './i18n.js';
import { $, enc, fmtNum, folderButton, h, icon, stepTitle, toast, toastError } from './ui.js';
import { categoryAction } from './categories.js';
import { templateAction } from './templates.js';
import { prefillRedirects, redirectAction } from './redirects.js';
import { healthAction } from './health.js';
import { urlAction } from './urls.js';
import { themeAction } from './themes.js';
import { duplicateAction } from './duplicates.js';
import { estLecture, etiquetteDe } from './actionIdentity.js';
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
// L'ordre est celui du menu. La santé du parc vient en tête : c'est par elle qu'on
// commence une journée, et c'est la seule qui ne modifie rien.
const ACTIONS = [healthAction, urlAction, duplicateAction, translateAction, templateAction, categoryAction, themeAction, redirectAction];

const state = {
  open: false,
  action: ACTIONS[0],
  serverId: null,
  serverLabel: '',
  servers: [],
  permissions: [],
  domains: [], // domaines du serveur courant (périmètre « tout le serveur »)
  loadingDomains: false,
  // « Liste de domaines » par defaut : c est le perimetre que l agent choisit presque
  // toujours, et le seul qui ne risque pas de lancer un traitement sur 1 838 sites
  // parce qu on a clique sans y penser.
  scope: 'list', // server | parc | list
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
  // Quand la tournée a commencé et quand elle a fini : le bandeau de fin dit combien
  // de temps elle a pris, ce qui est la première question posée après « combien ? ».
  demarre: 0,
  fini: 0,
  job: null, // la tournée suivie : c'est le serveur qui la mène
  lastSeq: -1, // dernier lot absorbé, pour ne demander que la suite
  encours: null, // une tournée que le serveur mène, qu'on ne suit pas encore
  historique: [], // les dernières tournées, pour en rouvrir une
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
    // « Liste de domaines » à l'ouverture, quel que soit le chemin emprunté. Les deux
    // autres périmètres désignent des milliers de sites d'un seul clic : qu'ils soient
    // choisis sciemment, et non trouvés déjà cochés.
    scope: 'list',
    text: '',
    resolved: null,
    resolving: false,
    total: 0,
    done: 0,
    cancel: false,
    job: null,
    lastSeq: -1,
    encours: null,
    historique: [],
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
  // Ce que le serveur fait en ce moment, et ce qu'il a fait : l'agent qui revient après
  // avoir fermé son navigateur doit le voir sans avoir à le deviner.
  rafraichirTournees();
  await (state.scope === 'parc' ? loadParcDomains() : loadServerDomains());
}

/**
 * Va voir où en sont les tournées.
 *
 * Deux choses en une : celle qui tourne encore — on propose de la suivre — et les
 * dernières terminées, qu'on peut rouvrir. Sans cet appel, un agent qui ferme son
 * navigateur pendant une tournée d'une heure reviendrait devant un écran vide,
 * persuadé que son travail est perdu.
 */
async function rafraichirTournees() {
  try {
    const out = await api('/api/jobs?limit=12');
    state.historique = out.jobs ?? [];
    state.encours = state.historique.find((j) => ['running', 'pending'].includes(j.status)) ?? null;
    render();
  } catch {
    // L'écran reste utilisable sans l'historique : ce n'est pas lui qui fait le travail.
  }
}

/** Rouvre une tournée : ses résultats se rechargent en quelques secondes. */
async function rouvrir(job) {
  const traitement = ACTIONS.find((a) => a.jobKind === job.kind);
  if (!traitement) return toast(t('actions.job_other_kind'), 'info');
  state.action = traitement;
  await reprendre(job);
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
    caps: state.servers.find((s) => s.id === site.server)?.capabilities ?? {},
    onClose: ({ statusChanged, status } = {}) => {
      // Le verrou a bougé là-bas : l'écran d'action l'affiche aussi, il doit suivre.
      if (statusChanged && site.lock) site.lock = { ...site.lock, status };
      resumeActions();
    },
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

/**
 * Lance la tournée : le SERVEUR la mène, l'écran la regarde.
 *
 * La boucle vivait ici, dans l'onglet. Fermer l'onglet arrêtait une tournée de 7 733
 * sites en plein milieu, et rien ne disait où elle en était. Désormais l'écran ne fait
 * que deux choses : confier le travail, puis absorber ce qui revient. L'agent peut
 * fermer son navigateur, se déconnecter, revenir le lendemain — le serveur continue.
 */
async function run() {
  const list = targets();
  if (!list.length) return toast(t('actions.no_target'), 'info');

  const action = state.action;
  action.reset();
  Object.assign(state, { phase: 'running', total: list.length, done: 0, cancel: false, job: null, lastSeq: -1, demarre: Date.now(), fini: 0 });
  render();

  try {
    // Ce dont l'écran a besoin et que la tournée ne rend pas : les moyens de traduction
    // disponibles sur chaque machine, par exemple.
    await action.before?.([...new Set(list.map((x) => x.server))].filter(Boolean));
    const job = await api('/api/jobs', {
      method: 'POST',
      body: {
        kind: action.jobKind,
        label: `${t(action.labelKey)} · ${list.length}`,
        params: action.jobParams?.(list) ?? {},
        targets: list,
      },
    });
    state.job = job;
    render();
    await suivre(job.id);
  } catch (err) {
    state.phase = 'done';
    state.fini = Date.now();
    render();
    toastError(err);
  }
}

/** Entre deux relevés. Assez court pour que l'écran vive, assez long pour ne pas peser. */
const SUIVI_MS = 1500;

/**
 * Suit une tournée jusqu'à son terme, en absorbant les lots au fur et à mesure.
 *
 * Reprendre une tournée d'hier, c'est exactement la même chose en repartant du lot zéro :
 * l'écran se remplit en quelques secondes avec tout ce que le serveur a déjà trouvé.
 */
async function suivre(id) {
  state.phase = 'running';
  const echecs = new Map();

  for (;;) {
    if (!state.open) return; // l'agent a quitté l'écran : le serveur, lui, continue
    let out;
    try {
      out = await api(`/api/jobs/${id}/results?after=${state.lastSeq}&limit=50`);
    } catch (err) {
      state.phase = 'done';
      render();
      return toastError(err);
    }

    state.job = out.job;
    state.total = out.job.total;
    state.done = out.job.done;

    for (const lot of out.results) {
      state.lastSeq = lot.seq;
      if (lot.payload?.error) {
        // Un lot perdu est COMPTÉ et NOMMÉ : l'agent doit savoir quels sites n'ont pas
        // été vus, et sur quelle machine. Un trou silencieux serait pire que l'échec.
        const cle = lot.server ?? '—';
        echecs.set(cle, (echecs.get(cle) ?? 0) + (lot.count ?? 0));
        continue;
      }
      state.action.absorb?.(lot.server, lot.payload);
    }
    // Les résultats portent un identifiant de serveur ; l'écran seul connaît son nom.
    if (out.results.length) state.action.labelServers?.(serverLabel);
    render();

    if (TERMINEES.includes(out.job.status)) {
      state.phase = 'done';
      state.fini = Date.now();
      render();
      for (const [server, n] of echecs) {
        toast(t('actions.server_failed', { server: serverLabel(server) }), 'error', t('actions.lost_targets', { count: fmtNum(n) }));
      }
      if (out.job.status === 'done' && !echecs.size) state.action.finished?.();
      // Le bandeau porte encore l'etat d'avant : sans ce rappel, il proposerait de
      // suivre une tournee deja terminee, et l'historique l'ignorerait.
      rafraichirTournees();
      return;
    }
    await new Promise((r) => setTimeout(r, SUIVI_MS));
  }
}

/** Une tournée dans l'un de ces états ne bougera plus. */
const TERMINEES = ['done', 'failed', 'cancelled'];

/**
 * Reprend la tournée en cours de ce traitement, s'il y en a une.
 *
 * C'est ce qui permet de fermer son navigateur : en revenant, l'écran retrouve la
 * tournée, absorbe tout ce qui a été fait pendant l'absence, et continue de suivre.
 */
async function reprendre(job) {
  state.action.reset();
  Object.assign(state, { job, total: job.total, done: job.done, lastSeq: -1, cancel: false });
  await state.action.before?.([]);
  await suivre(job.id);
}

/** Demande l'arrêt de la tournée en cours. Le serveur s'arrête entre deux lots. */
async function arreter() {
  if (!state.job) { state.cancel = true; return; }
  try {
    await api(`/api/jobs/${state.job.id}/cancel`, { method: 'POST' });
    toast(t('actions.stopping'));
  } catch (err) {
    toastError(err);
  }
}

// ───────────────────────── Rendu ─────────────────────────

/**
 * DU SCANNER 404 VERS LA REDIRECTION 301, sans rien recopier à la main.
 *
 * Le scanner vient de mesurer quelles adresses sont mortes et sur quels sites. Les faire
 * ressaisir une par une serait une perte de temps et une source de fautes de frappe —
 * dans des adresses de soixante caractères, une faute ne se voit pas.
 *
 * Trois choses passent : les adresses de départ, les sites concernés, et le changement
 * d'action. La DESTINATION reste vide : c'est à l'agent de décider où envoyer le visiteur,
 * et personne d'autre ne peut le savoir à sa place.
 */
async function versRedirection({ paths = [], domains = [] } = {}) {
  if (!paths.length) return;
  prefillRedirects(paths);
  state.action = redirectAction;
  state.phase = 'idle';
  // Le périmètre devient la liste des sites où l'adresse est morte, et non tout le
  // serveur : rediriger ailleurs poserait un fichier sur des sites qui n'ont rien.
  state.scope = 'list';
  state.text = domains.join('\n');
  majZoneListe();
  render();
  await resolveList();
  toast(t('urls.handed_over', { count: String(paths.length), sites: String(domains.length) }), 'info');
}

function render() {
  if (!state.open) return;
  $('#page-title').textContent = t('actions.title');
  $('#page-sub').classList.remove('font-mono');
  $('#page-sub').textContent = state.serverId ? state.serverLabel : t('actions.all_servers');
  $('#page-state').replaceChildren();

  // Les étapes se numérotent toutes seules : une action sans formulaire commence au
  // choix des sites. L'agent suit 1, 2, 3 sans qu'on lui explique.
  const avecForm = Boolean(state.action.form);
  const lecture = estLecture(state.action.key);
  const etape = { form: 1, scope: avecForm ? 2 : 1, results: avecForm ? 3 : 2 };
  const results = state.action.results({ permissions: state.permissions, openFiles: openFilesFor, handover: versRedirection });
  const vide = !results && state.phase === 'done' ? state.action.emptyState?.() : null;
  // Le formulaire a besoin des sites : supprimer une rubrique suppose de savoir
  // lesquelles sont en place, et cela se lit sur les sites choisis.
  const formulaire = state.action.form?.({ permissions: state.permissions, step: etape.form, targets: targets() });
  const perimetre = scopeCard(etape.scope);

  const body = [
    enTete(),
    bandeauConnexion(),
    // Deux saisies courtes valent mieux côte à côte : l'écran tenait sur trois cartes
    // empilées, avec un vide au milieu et le bouton perdu en bas.
    formulaire
      ? (formulaire.classList.add('xl:col-span-2'),
        h('div', { class: 'grid items-start gap-4 xl:grid-cols-3' }, formulaire, perimetre))
      : perimetre,
    runBar(),
    // Ce que le serveur mene ou a mene : l'agent qui revient le retrouve ici.
    bandeauTournees(),
    // Dire que c'est fini, AVANT de montrer les chiffres et le detail.
    banniereFin(),
    statsRow(),
    // En-tête de section plutôt qu'une carte : la vérification n'est pas une saisie.
    // LE TITRE DE CETTE ÉTAPE DÉPEND DE LA FAMILLE. Il annonçait « Vérification — rien
    // n'est encore écrit, relisez puis lancez la création » même sur une analyse en
    // lecture seule, où il n'y a rien à relire et rien à créer. Les deux familles n'ont
    // pas la même suite : l'une rend un constat, l'autre une proposition à valider.
    results || vide
      ? h(
          'div',
          { class: 'px-1 pt-2' },
          lecture
            ? stepTitle(etape.results, t('actions.step_read'), t('actions.step_read_hint'))
            : stepTitle(etape.results, t('actions.step_result'), t('actions.step_result_hint')),
        )
      : null,
    results ?? vide,
  ];
  $('#actions-view').replaceChildren(...body.filter(Boolean));
}

/**
 * L'EN-TÊTE DE L'ACTION : qui elle est, ce qu'elle touche, et où elle en est.
 *
 * Les huit traitements se présentaient de la même façon, et rien ne disait lequel se
 * contente de LIRE et lequel ÉCRIT sur des sites en production. Ce bandeau porte donc
 * trois choses, dans cet ordre de lecture :
 *
 *   1. le nom et l'icône du traitement, sur fond sombre — c'est l'en-tête du logiciel,
 *      il ne bouge pas, et c'est ce qui fait qu'on reconnaît l'outil d'un écran à
 *      l'autre ;
 *   2. son ÉTIQUETTE DE FAMILLE, « lecture seule » ou « écrit sur les sites ». Elle
 *      vient de `actionIdentity.js`, elle est verte ou ambre, et elle se lit avant le
 *      bouton de lancement, pas après ;
 *   3. une ligne d'état en chasse fixe, qui dit en direct le périmètre et le nombre de
 *      sites retenus. Elle se met à jour pendant que l'agent compose son lot.
 *
 * La chasse fixe et le fond sombre sont le parti pris demandé — un terminal moderne —
 * mais rien n'y est écrit en jargon : l'agent lit des mots, jamais une commande.
 */
function enTete() {
  const action = state.action;
  const etiquette = etiquetteDe(action.key);

  const select = h(
    'select',
    {
      class:
        'rounded-lg border border-ink-700 bg-ink-800 px-3 py-1.5 text-sm font-medium text-white focus:border-accent focus:ring-2 focus:ring-accent/30 focus:outline-none',
      'aria-label': t('actions.choose'),
      disabled: state.phase === 'running',
      onchange: (e) => {
        state.action = ACTIONS.find((a) => a.key === e.target.value) ?? ACTIONS[0];
        state.phase = 'idle';
        render();
      },
    },
    ACTIONS.map((a) => h('option', { value: a.key, selected: a.key === action.key }, t(a.labelKey))),
  );

  return h(
    'section',
    { class: 'overflow-hidden rounded-2xl border border-ink-100 shadow-sm' },
    h(
      'header',
      { class: 'flex flex-wrap items-center gap-x-4 gap-y-3 bg-ink px-5 py-3.5' },
      h('span', { class: 'flex size-10 shrink-0 items-center justify-center rounded-lg bg-white/10 text-accent' }, icon(action.icon, 'size-5')),
      h(
        'div',
        { class: 'min-w-0' },
        h('h2', { class: 'truncate text-base font-semibold text-white' }, t(action.labelKey)),
        // Le mot « Action » en petit : il dit à quoi sert la liste déroulante d'à côté.
        h('p', { class: 'text-[0.7rem] font-medium tracking-widest text-ink-300 uppercase' }, t('actions.choose')),
      ),
      h('span', { class: 'flex-1' }),
      etiquetteFamille(etiquette),
      select,
    ),
    h(
      'div',
      { class: 'border-t border-ink-100 bg-white px-5 py-3' },
      ligneEtat(),
      h('p', { class: 'mt-1.5 text-sm text-ink-500' }, t(action.hintKey)),
    ),
  );
}

/** « Lecture seule » ou « Écrit sur les sites », avec son point de couleur. */
function etiquetteFamille(etiquette) {
  return h(
    'span',
    {
      class: `badge ${etiquette.classes}`,
      title: t(etiquette.hintKey),
    },
    h('span', { class: `size-1.5 rounded-full ${etiquette.point}` }),
    t(etiquette.labelKey),
  );
}

/**
 * La ligne d'état, en chasse fixe : périmètre, nombre de sites, et rien d'autre.
 *
 * Elle répond à la question que l'agent se pose juste avant de cliquer — « sur quoi
 * est-ce que je lance ça, au juste ? » — sans qu'il ait à relire l'écran entier. Les
 * séparateurs « · » et la chasse fixe alignent les trois renseignements comme une
 * ligne de statut, ce qui se parcourt plus vite qu'une phrase.
 */
function ligneEtat() {
  const count = targets().length;
  const perimetre = state.action.targets?.()
    ? t('actions.scope_from_form')
    : t(state.scope === 'server' ? 'actions.scope_server' : state.scope === 'parc' ? 'actions.scope_parc' : 'actions.scope_list');

  const morceau = (txt, classes = 'text-ink-500') => h('span', { class: classes }, txt);
  const point = () => h('span', { class: 'text-ink-300' }, '·');

  return h(
    'p',
    { class: 'flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs' },
    h('span', { class: 'text-accent-700' }, '▸'),
    morceau(perimetre.toLowerCase(), 'text-ink'),
    point(),
    morceau(t('actions.selected', { count: fmtNum(count) }), count ? 'font-semibold text-ink' : 'text-ink-400'),
    state.serverId ? point() : null,
    state.serverId ? morceau(state.serverLabel, 'text-ink-400') : null,
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
        ? h('button', { type: 'button', class: 'btn btn-outline', onclick: arreter }, t('actions.stop'))
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
 * Recopie `state.text` dans le champ quand c'est le CODE qui l'a changé.
 *
 * Le champ garde normalement sa valeur tout seul, puisque c'est le même élément d'un rendu
 * à l'autre. Mais quand le scanner 404 remplit la liste des sites à notre place, rien ne
 * la porte à l'écran : l'agent verrait un champ vide et un décompte qui annonce douze
 * domaines. À n'appeler que dans ce sens-là.
 */
function majZoneListe() {
  if (listArea) listArea.value = state.text;
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

/**
 * Le bandeau des tournées.
 *
 * Il ne s'affiche que s'il a quelque chose à dire : une tournée en cours qu'on ne suit
 * pas, ou des tournées passées qu'on peut rouvrir. Le reste du temps il disparaît — un
 * écran qui montre en permanence ce qui ne sert pas finit par ne plus être lu.
 */
function bandeauTournees() {
  const suitDeja = state.phase === 'running' && state.job;
  const encours = !suitDeja && state.encours ? state.encours : null;
  const passees = state.historique.filter((j) => TERMINEES.includes(j.status) && j.done > 0).slice(0, 4);
  if (!encours && !passees.length) return null;

  const ligne = (job, bouton) =>
    h(
      'div',
      { class: 'flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-sm' },
      h('span', { class: 'font-medium' }, job.label || job.kind),
      h('span', { class: 'text-ink-400' }, t(`actions.job_status_${job.status}`)),
      h('span', { class: 'text-ink-400' }, t('actions.progress', { done: fmtNum(job.done), total: fmtNum(job.total) })),
      job.failed ? h('span', { class: 'text-red-600' }, t('actions.lost_targets', { count: fmtNum(job.failed) })) : null,
      h('span', { class: 'text-ink-300' }, job.by?.name || '—'),
      h('span', { class: 'flex-1' }),
      bouton,
    );

  return h(
    'div',
    { class: 'card px-5 py-3' },
    encours
      ? ligne(
        encours,
        h('button', { type: 'button', class: 'btn btn-primary px-4 py-1.5', onclick: () => rouvrir(encours) }, icon('refresh'), t('actions.job_follow')),
      )
      : null,
    passees.length
      ? h(
        'details',
        { class: encours ? 'mt-2 border-t border-ink-100 pt-2' : '' },
        h('summary', { class: 'cursor-pointer text-sm text-ink-500' }, t('actions.job_history', { count: passees.length })),
        h('div', { class: 'mt-1 divide-y divide-ink-100' }, passees.map((job) => ligne(
          job,
          h('button', { type: 'button', class: 'btn btn-ghost px-3 py-1', onclick: () => rouvrir(job) }, t('actions.job_reopen')),
        ))),
      )
      : null,
  );
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

/**
 * Une durée, dite comme on la dit à voix haute.
 *
 * « 1 862 s » ne veut rien dire pour personne ; « 31 min » se comprend sans calcul. En
 * dessous de la minute, les secondes ; au-delà de l'heure, les deux.
 */
function duree(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return t('actions.dur_s', { n: fmtNum(s) });
  const m = Math.round(s / 60);
  if (m < 60) return t('actions.dur_min', { n: fmtNum(m) });
  return t('actions.dur_h', { h: fmtNum(Math.floor(m / 60)), m: fmtNum(m % 60) });
}

/**
 * LE BANDEAU DE FIN : ce qui vient de se passer, dit en une ligne.
 *
 * L'écran passait de « barre de progression » à « tableau de résultats » sans rien dire
 * entre les deux : l'agent devait déduire que c'était fini. Il l'est désormais dit, avec
 * le nombre de sites traités, le temps que cela a pris, et — pour les traitements de
 * lecture — le rappel qu'AUCUNE ÉCRITURE N'A EU LIEU. Cette dernière phrase n'est pas
 * ornementale : elle est la contrepartie de l'étiquette affichée avant le lancement, et
 * elle vaut d'être tenue jusqu'au bout.
 */
function banniereFin() {
  if (state.phase !== 'done' || !state.total) return null;
  const complet = state.done >= state.total;
  const ecoule = state.demarre > 0 && state.fini > state.demarre ? state.fini - state.demarre : 0;
  const temps = ecoule >= 1000 ? duree(ecoule) : null;
  const lecture = estLecture(state.action.key);

  return h(
    'div',
    {
      class: `flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-4 py-3 text-sm ${
        complet ? 'border-accent-200 bg-accent-50' : 'border-amber-200 bg-amber-50'
      }`,
    },
    icon(complet ? 'check' : 'alert', `size-4 shrink-0 ${complet ? 'text-accent-700' : 'text-amber-700'}`),
    h(
      'span',
      { class: `font-semibold ${complet ? 'text-accent-700' : 'text-amber-800'}` },
      complet ? t('actions.done_title') : t('actions.done_partial'),
    ),
    h(
      'span',
      { class: 'font-mono text-xs text-ink-500' },
      t('actions.done_count', { done: fmtNum(state.done), total: fmtNum(state.total) }),
    ),
    // En dessous de la seconde, la durée n'apprend rien et « 0 s » a l'air d'une mesure
    // manquante. On se tait plutôt que d'afficher un chiffre qui ferait douter du reste.
    temps ? h('span', { class: 'font-mono text-xs text-ink-400' }, `· ${temps}`) : null,
    h('span', { class: 'flex-1' }),
    // Le rappel ne s'affiche que là où il est vrai.
    lecture ? h('span', { class: 'text-xs text-ink-400' }, t('actions.done_read_only')) : null,
  );
}

// Classes écrites en toutes lettres : Tailwind lit ce fichier pour produire sa feuille,
// et ne verrait pas une classe assemblée à l'exécution.
const GRID = ['sm:grid-cols-2', 'sm:grid-cols-2', 'sm:grid-cols-3', 'sm:grid-cols-2 lg:grid-cols-4', 'sm:grid-cols-3 lg:grid-cols-5'];

/**
 * LES CHIFFRES DE L'ACTION, en un seul bloc et non en tuiles éparpillées.
 *
 * Chaque traitement a les siens — sites sondés, adresses mortes, groupes de doublons —
 * et ils sont déclarés par l'action elle-même. Ce qui change ici, c'est la présentation :
 * un seul cadre, des colonnes séparées d'un filet, des nombres en chasse fixe alignés à
 * la même hauteur. Des tuiles indépendantes se lisaient une par une ; une rangée se
 * compare d'un coup d'œil, ce qui est précisément ce qu'on fait avec des chiffres.
 */
function statsRow() {
  if (state.phase === 'idle') return null;
  const cells = state.action.stats();
  if (!cells.length) return null;
  return h(
    'section',
    { class: 'card overflow-hidden' },
    h(
      'header',
      { class: 'flex items-center gap-2 border-b border-ink-100 bg-ink-50 px-4 py-2' },
      h('span', { class: 'font-mono text-[0.7rem] tracking-widest text-ink-400 uppercase' }, t('actions.stats_title')),
      h('span', { class: 'flex-1' }),
      h('span', { class: 'font-mono text-[0.7rem] text-ink-300' }, t(state.action.labelKey)),
    ),
    h(
      'div',
      { class: `grid grid-cols-2 divide-ink-100 sm:divide-x ${GRID[Math.min(cells.length, GRID.length) - 1]}` },
      cells.map(([key, value, tone, hint]) =>
        h(
          'div',
          { class: 'px-4 py-3', title: hint ? t(hint) : null },
          h('p', { class: 'truncate text-[0.7rem] font-medium tracking-wide text-ink-400 uppercase' }, t(key)),
          h('p', { class: `mt-0.5 font-mono text-2xl font-semibold tabular-nums ${tone ?? 'text-ink'}` }, value),
        ),
      ),
    ),
  );
}

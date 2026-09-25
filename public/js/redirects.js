import { api } from './api.js';
import { t } from './i18n.js';
import { closeModal, enc, fmtNum, folderButton, h, icon, modalHeader, openModal, stepTitle, toast, toastError } from './ui.js';

/**
 * Action « Redirections 301 ».
 *
 * Elle s'adresse à un agent qui voit une page en 404 et veut l'envoyer ailleurs. On ne
 * lui parle donc que de deux adresses — celle qui ne marche plus, celle qui marche — et
 * jamais de `.htaccess`, de mod_rewrite ni d'Apache.
 *
 *   1. LES REDIRECTIONS — une ou plusieurs paires « ancienne → nouvelle ».
 *   2. LES SITES — le périmètre habituel de l'écran.
 *   3. VÉRIFIER, puis APPLIQUER.
 *
 * La vérification est obligatoire et montre, site par site, ce qui est déjà en place,
 * ce qui serait ajouté, et surtout ce qui EMPÊCHERAIT d'écrire : fichier absent, ligne
 * de repère introuvable, fichier non modifiable. Sur le parc, ce dernier cas concerne
 * 4 sites sur 5 : le taire ferait passer un refus de droits pour une panne.
 */

const MAX_REGLES = 20;

const state = {
  operation: 'add', // add | remove
  regles: [{ from: '', to: '' }],
  plan: null,
  selected: null,
  done: new Map(), // clé de site → nombre de règles écrites
};

const keyOf = (site) => `${site.server}/${site.domain}`;

/** Ce que l'agent a réellement saisi : les paires complètes, dans l'ordre. */
const reglesSaisies = () =>
  state.regles
    .map((r) => ({ from: r.from.trim(), to: r.to.trim() }))
    .filter((r) => r.from && (state.operation === 'remove' || r.to));

/**
 * Une adresse acceptable. Même règle que côté serveur, qui a le dernier mot — et qui
 * la revérifie, puis le script PHP une troisième fois.
 *
 * Le refus des blancs n'est pas cosmétique : un saut de ligne dans une adresse
 * laisserait écrire n'importe quelle directive Apache dans le fichier.
 */
export function urlValide(u, { destination = false } = {}) {
  const v = String(u ?? '').trim();
  if (!v || v.length > 512) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f"]/.test(v)) return false;
  if (v.startsWith('/')) return true;
  return destination && /^https?:\/\/[^/\s]+/i.test(v);
}

/**
 * Ce que l'agent colle depuis son navigateur : on accepte une URL entière et on n'en
 * garde que le chemin. « https://exemple.com/page.php?x=1 » devient « /page.php ».
 *
 * Sans le « https:// », en revanche, on ne devine rien : « exemple.com/page.php »
 * devient « /exemple.com/page.php », parce que c'est peut-être un vrai chemin. La
 * ligne exacte qui sera écrite s'affiche sous le champ : l'agent voit ce qu'il aura,
 * plutôt que de subir une correction silencieuse qui se tromperait parfois.
 */
export function versChemin(brut) {
  const v = String(brut ?? '').trim();
  if (!v) return '';
  const sansHote = v.replace(/^https?:\/\/[^/]+/i, '');
  const sansQuery = sansHote.replace(/[?#].*$/, '');
  if (!sansQuery) return '/';
  return sansQuery.startsWith('/') ? sansQuery : `/${sansQuery}`;
}

/** La demande envoyée au serveur : domaine → somme de contrôle + règles. */
function demande(cibles) {
  const regles = reglesSaisies();
  return Object.fromEntries(
    cibles.map((x) => {
      // La somme de contrôle vue à la vérification : si le fichier a bougé depuis,
      // le serveur refuse plutôt que d'écrire dans un fichier qu'on n'a pas montré.
      const vu = (state.plan?.sites ?? []).find((s) => s.domain === x.domain && s.server === x.server);
      return [x.domain, { md5: vu?.md5 ?? '', rules: regles }];
    }),
  );
}

// ───────────────────────── Étape 1 : les redirections ─────────────────────────

function champsRegle(index) {
  const r = state.regles[index];
  const maj = (champ) => (e) => {
    r[champ] = e.target.value;
    const ligne = e.target.closest('[data-regle]');
    ligne?.querySelector('[data-apercu]')?.replaceChildren(apercu(r));
  };
  // Coller une URL entière est le geste naturel : on la ramène à son chemin en
  // quittant le champ, sans rien dire, plutôt que de refuser la saisie.
  const nettoyer = (champ) => (e) => {
    const propre = versChemin(e.target.value);
    if (propre && propre !== e.target.value.trim()) {
      e.target.value = propre;
      r[champ] = propre;
      redirectAction.onChange?.();
    }
  };

  const champ = (champName, placeholder, aria) =>
    h('input', {
      class: 'input w-full',
      value: r[champName],
      placeholder,
      'aria-label': aria,
      autocomplete: 'off',
      spellcheck: 'false',
      oninput: maj(champName),
      onblur: nettoyer(champName),
    });

  return h(
    'div',
    { class: 'rounded-lg border border-ink-200 bg-white p-3', 'data-regle': '' },
    h(
      'div',
      { class: 'flex flex-wrap items-center gap-2' },
      h(
        'div',
        { class: 'min-w-0 flex-1 basis-64' },
        h('p', { class: 'mb-1 text-[11px] font-medium tracking-wide text-ink-400 uppercase' }, t('redirects.from_label')),
        champ('from', t('redirects.from_placeholder'), t('redirects.from_label')),
      ),
      h('span', { class: 'mt-5 shrink-0 text-ink-300' }, icon('arrowRight', 'size-4')),
      state.operation === 'add'
        ? h(
            'div',
            { class: 'min-w-0 flex-1 basis-64' },
            h('p', { class: 'mb-1 text-[11px] font-medium tracking-wide text-ink-400 uppercase' }, t('redirects.to_label')),
            champ('to', t('redirects.to_placeholder'), t('redirects.to_label')),
          )
        : null,
      state.regles.length > 1
        ? h(
            'button',
            {
              type: 'button',
              class: 'icon-btn mt-5 shrink-0',
              'aria-label': t('action.delete'),
              onclick: () => {
                state.regles.splice(index, 1);
                redirectAction.reset();
                redirectAction.onChange?.();
              },
            },
            icon('trash'),
          )
        : null,
    ),
    h('div', { class: 'mt-2', 'data-apercu': '' }, apercu(r)),
  );
}

/** La ligne telle qu'elle sera écrite — ou ce qui cloche dans la saisie. */
function apercu(r) {
  const from = String(r.from ?? '').trim();
  const to = String(r.to ?? '').trim();
  if (!from) return h('span', {});
  if (!urlValide(from)) return h('p', { class: 'text-xs text-red-600' }, t('redirects.bad_from'));
  if (state.operation === 'remove') return h('p', { class: 'font-mono text-[11px] text-ink-400' }, from);
  if (!to) return h('span', {});
  if (!urlValide(to, { destination: true })) return h('p', { class: 'text-xs text-red-600' }, t('redirects.bad_to'));
  if (from === to) return h('p', { class: 'text-xs text-red-600' }, t('redirects.loop'));
  return h('p', { class: 'font-mono text-[11px] break-all text-ink-400' }, `Redirect 301 ${from} ${to}`);
}

function formulaire() {
  return h(
    'div',
    { class: 'mt-4 space-y-2' },
    state.regles.map((_, i) => champsRegle(i)),
    state.regles.length < MAX_REGLES
      ? h(
          'button',
          {
            type: 'button',
            class: 'btn btn-ghost px-2 py-1 text-xs',
            onclick: () => {
              state.regles.push({ from: '', to: '' });
              redirectAction.onChange?.();
            },
          },
          icon('plus', 'size-3.5'),
          t('redirects.add_row'),
        )
      : null,
  );
}

// ───────────────────────── Étape 3 : le résultat ─────────────────────────

const ERREURS = ['no_htaccess', 'unreadable', 'no_marker', 'many_markers', 'block_broken', 'changed', 'not_writable', 'backup_failed', 'write_failed', 'verify_failed'];
const messageErreur = (cle) => (ERREURS.includes(cle) ? t(`redirects.error_${cle}`) : cle);

/** Un site est prêt si on peut vraiment y écrire : sinon on dit lequel des trois. */
const pret = (s) => !s.error && s.writable;

function listeSites() {
  const sites = state.plan?.sites ?? [];
  const item = (s) => {
    const actif = keyOf(s) === state.selected;
    const fait = state.done.get(keyOf(s));
    return h(
      'button',
      {
        type: 'button',
        class: `flex w-full items-center gap-2 border-l-2 px-4 py-2.5 text-left transition ${
          actif ? 'border-accent bg-accent-50' : 'border-transparent hover:bg-ink-50'
        }`,
        onclick: () => {
          state.selected = keyOf(s);
          redirectAction.onChange?.();
        },
      },
      h(
        'span',
        { class: 'min-w-0 flex-1' },
        h('span', { class: 'block truncate text-sm font-medium' }, s.domain),
        h(
          'span',
          { class: 'block text-[11px] text-ink-400' },
          s.error ? messageErreur(s.error) : !s.writable ? t('redirects.error_not_writable') : t('redirects.in_place', { count: fmtNum(s.existing.length) }),
        ),
      ),
      fait != null
        ? h('span', { class: 'badge shrink-0 bg-accent-100 text-accent-700' }, icon('check', 'size-3'), fmtNum(fait))
        : pret(s)
          ? null
          : h('span', { class: 'badge shrink-0 bg-red-100 text-red-700' }, icon('alert', 'size-3')),
    );
  };
  return h('div', { class: 'card max-h-[32rem] divide-y divide-ink-100 overflow-y-auto' }, sites.map(item));
}

const ETATS = {
  to_add: 'bg-accent-100 text-accent-800',
  present: 'bg-ink-100 text-ink-500',
  conflict: 'bg-amber-100 text-amber-800',
  to_remove: 'bg-red-100 text-red-700',
  absent: 'bg-ink-100 text-ink-400',
  invalid: 'bg-red-100 text-red-700',
  loop: 'bg-red-100 text-red-700',
};

function detailSite(permissions, openFilesFor) {
  const site = (state.plan?.sites ?? []).find((s) => keyOf(s) === state.selected);
  if (!site) return h('div', { class: 'card px-6 py-16 text-center text-ink-400' }, t('redirects.pick_site'));

  const enTete = h(
    'div',
    { class: 'flex flex-wrap items-center gap-3 border-b border-ink-100 px-5 py-4' },
    h(
      'div',
      { class: 'min-w-0 flex-1' },
      h(
        'div',
        { class: 'flex flex-wrap items-center gap-2' },
        h('h3', { class: 'truncate font-semibold' }, site.domain),
        h('span', { class: 'badge bg-ink-50 text-ink-500' }, site.serverLabel),
        state.done.has(keyOf(site)) ? h('span', { class: 'badge bg-accent-100 text-accent-700' }, icon('check', 'size-3.5'), t('redirects.done_badge')) : null,
      ),
      site.markerAt
        ? h('p', { class: 'mt-1 text-xs text-ink-400' }, t('redirects.marker_at', { line: fmtNum(site.markerAt) }))
        : null,
    ),
    // Le .htaccess est à un clic : l'agent peut aller le relire lui-même.
    folderButton(permissions, openFilesFor && (() => openFilesFor(site))),
    boutonAppliquer([site], permissions, t('redirects.apply_site')),
  );

  if (site.error) {
    return h(
      'div',
      { class: 'card overflow-hidden' },
      enTete,
      h(
        'div',
        { class: 'px-6 py-12 text-center' },
        h('span', { class: 'mx-auto flex size-12 items-center justify-center rounded-2xl bg-red-50 text-red-600' }, icon('alert', 'size-6')),
        h('p', { class: 'mt-4 font-semibold' }, messageErreur(site.error)),
        h('p', { class: 'mx-auto mt-2 max-w-lg text-sm text-ink-500' }, t(`redirects.hint_${site.error}`)),
      ),
    );
  }

  // Ce que la demande ferait.
  const propositions = site.items.map((it) =>
    h(
      'div',
      { class: 'flex flex-wrap items-center gap-3 px-5 py-2.5' },
      h(
        'div',
        { class: 'min-w-0 flex-1' },
        h('p', { class: 'font-mono text-xs break-all' }, it.from),
        it.to && it.to !== it.from ? h('p', { class: 'font-mono text-[11px] break-all text-ink-400' }, `→ ${it.to}`) : null,
        it.state === 'conflict' ? h('p', { class: 'text-[11px] text-amber-700' }, t('redirects.replaces', { url: it.current })) : null,
      ),
      h('span', { class: `badge shrink-0 ${ETATS[it.state] ?? ETATS.absent}` }, t(`redirects.state_${it.state}`)),
    ),
  );

  // Ce qui est déjà dans le fichier, écrit par l'application.
  const enPlace = site.existing.length
    ? h(
        'div',
        { class: 'border-t border-ink-100' },
        h('p', { class: 'px-5 pt-4 pb-1 text-xs font-semibold tracking-wide text-ink-400 uppercase' }, t('redirects.table_title')),
        h(
          'table',
          { class: 'w-full text-left' },
          h(
            'thead',
            { class: 'text-[11px] tracking-wide text-ink-400 uppercase' },
            h('tr', {}, h('th', { class: 'px-5 py-2 font-semibold' }, t('redirects.col_from')), h('th', { class: 'px-4 py-2 font-semibold' }, t('redirects.col_to')), h('th', { class: 'px-5 py-2' })),
          ),
          h(
            'tbody',
            {},
            site.existing.map((r) =>
              h(
                'tr',
                { class: 'border-t border-ink-100' },
                h('td', { class: 'px-5 py-2 font-mono text-xs break-all' }, r.from),
                h('td', { class: 'px-4 py-2 font-mono text-xs break-all text-ink-500' }, r.to),
                h(
                  'td',
                  { class: 'px-5 py-2 text-right' },
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'icon-btn hover:bg-red-50 hover:text-red-600',
                      'aria-label': t('redirects.remove_one'),
                      title: t('redirects.remove_one'),
                      disabled: !permissions.includes('design.publish') || !site.writable,
                      onclick: () => confirmerRetrait(site, r),
                    },
                    icon('trash'),
                  ),
                ),
              ),
            ),
          ),
        ),
      )
    : h('p', { class: 'border-t border-ink-100 px-5 py-4 text-sm text-ink-400' }, t('redirects.table_empty'));

  return h(
    'div',
    { class: 'card overflow-hidden' },
    enTete,
    !site.writable
      ? h(
          'p',
          { class: 'flex flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-5 py-3 text-sm text-amber-800' },
          icon('lock', 'size-4 shrink-0'),
          t('redirects.error_not_writable'),
          h('span', { class: 'text-amber-700' }, t('redirects.hint_not_writable')),
        )
      : null,
    propositions.length ? h('div', { class: 'divide-y divide-ink-100' }, propositions) : null,
    enPlace,
    site.foreign
      ? h('p', { class: 'border-t border-ink-100 px-5 py-3 text-xs text-ink-400' }, t('redirects.foreign', { count: fmtNum(site.foreign) }))
      : null,
  );
}

// ───────────────────────── Écriture ─────────────────────────

function boutonAppliquer(sites, permissions, libelle) {
  const cibles = sites.filter(pret);
  const peut = permissions.includes('design.publish');
  return h(
    'button',
    {
      type: 'button',
      class: 'btn btn-primary',
      disabled: !peut || !cibles.length,
      title: peut ? null : t('reason.permission_denied'),
      onclick: () => confirmerPose(cibles),
    },
    icon('save'),
    libelle,
  );
}

function barre(permissions) {
  const sites = state.plan?.sites ?? [];
  const prets = sites.filter(pret);
  const bloques = sites.length - prets.length;
  return h(
    'div',
    { class: 'card flex flex-wrap items-center gap-3 px-4 py-3' },
    h(
      'div',
      { class: 'min-w-0 flex-1' },
      h('p', { class: 'text-sm font-medium' }, t('redirects.bulk_hint', { sites: fmtNum(prets.length), rules: fmtNum(reglesSaisies().length) })),
      bloques ? h('p', { class: 'mt-0.5 text-xs text-amber-700' }, t('redirects.bulk_blocked', { count: fmtNum(bloques) })) : null,
    ),
    boutonAppliquer(sites, permissions, t('redirects.apply_all', { count: fmtNum(prets.length) })),
  );
}

/** La fenêtre qui dit, avant d'écrire, ce qui va être écrit et où. */
function confirmerPose(sites) {
  const regles = reglesSaisies();
  const aEcrire = sites.reduce((n, s) => n + s.items.filter((it) => it.state === 'to_add' || it.state === 'conflict').length, 0);
  if (!aEcrire) return toast(t('redirects.nothing_to_do'), 'info');

  const bouton = h('button', { type: 'button', class: 'btn btn-primary' }, icon('save'), t('redirects.confirm_go'));
  bouton.addEventListener('click', () => {
    closeModal();
    poser(sites);
  });

  openModal(
    h(
      'div',
      { class: 'card w-full max-w-xl p-0' },
      modalHeader(t('redirects.confirm_title'), 'bg-accent-50 text-accent-700', 'save'),
      h(
        'div',
        { class: 'space-y-3 px-6 py-5' },
        h('p', { class: 'text-sm' }, t('redirects.confirm_body', { rules: fmtNum(aEcrire), sites: fmtNum(sites.length) })),
        h(
          'div',
          { class: 'rounded-lg bg-ink-50 p-3 font-mono text-[11px] break-all' },
          regles.slice(0, 4).map((r) => h('p', {}, `Redirect 301 ${r.from} ${r.to}`)),
          regles.length > 4 ? h('p', { class: 'text-ink-400' }, `… ${fmtNum(regles.length - 4)}`) : null,
        ),
        h('p', { class: 'text-xs text-ink-500' }, t('redirects.confirm_note')),
      ),
      h(
        'div',
        { class: 'flex justify-end gap-2 border-t border-ink-100 px-6 py-4' },
        h('button', { type: 'button', class: 'btn btn-outline', onclick: closeModal }, t('action.cancel')),
        bouton,
      ),
    ),
  );
}

function confirmerRetrait(site, regle) {
  const bouton = h('button', { type: 'button', class: 'btn btn-danger' }, icon('trash'), t('redirects.remove_go'));
  bouton.addEventListener('click', () => {
    closeModal();
    retirer(site, regle);
  });
  openModal(
    h(
      'div',
      { class: 'card w-full max-w-lg p-0' },
      modalHeader(t('redirects.remove_title'), 'bg-red-50 text-red-600', 'trash'),
      h(
        'div',
        { class: 'space-y-3 px-6 py-5' },
        h('p', { class: 'text-sm' }, t('redirects.remove_body', { domain: site.domain })),
        h('p', { class: 'rounded-lg bg-ink-50 p-3 font-mono text-[11px] break-all' }, `Redirect 301 ${regle.from} ${regle.to}`),
        h('p', { class: 'text-xs text-ink-500' }, t('redirects.remove_note')),
      ),
      h(
        'div',
        { class: 'flex justify-end gap-2 border-t border-ink-100 px-6 py-4' },
        h('button', { type: 'button', class: 'btn btn-outline', onclick: closeModal }, t('action.cancel')),
        bouton,
      ),
    ),
  );
}

/** Applique le résultat d'une écriture sur le plan affiché. */
function absorber(out) {
  for (const s of out.sites ?? []) {
    const cible = (state.plan?.sites ?? []).find((x) => x.domain === s.domain);
    if (!cible) continue;
    Object.assign(cible, { error: s.error, md5: s.md5, existing: s.existing, foreign: s.foreign, writable: s.writable, items: s.items, stamp: s.stamp });
    const faites = s.items.filter((it) => it.done.length).length;
    if (faites) state.done.set(keyOf(cible), (state.done.get(keyOf(cible)) ?? 0) + faites);
  }
}

async function poser(sites) {
  const parServeur = new Map();
  for (const s of sites) parServeur.set(s.server, [...(parServeur.get(s.server) ?? []), s]);
  let total = 0;
  let echecs = 0;
  try {
    for (const [server, liste] of parServeur) {
      const out = await api(`/api/servers/${enc(server)}/redirects/apply`, {
        method: 'POST',
        body: { request: demande(liste.map((s) => ({ domain: s.domain, server }))), operation: 'add' },
      });
      absorber(out);
      for (const s of out.sites ?? []) {
        total += s.items.filter((it) => it.done.length).length;
        if (s.error) echecs += 1;
      }
    }
    toast(t('redirects.applied', { count: fmtNum(total) }), echecs ? 'info' : 'success');
    if (echecs) toast(t('redirects.applied_failed', { count: fmtNum(echecs) }), 'error');
  } catch (err) {
    toastError(err);
  } finally {
    redirectAction.onChange?.();
  }
}

async function retirer(site, regle) {
  try {
    const out = await api(`/api/servers/${enc(site.server)}/redirects/apply`, {
      method: 'POST',
      body: { request: { [site.domain]: { md5: site.md5 ?? '', rules: [{ from: regle.from, to: regle.to }] } }, operation: 'remove' },
    });
    absorber(out);
    const s = out.sites?.[0];
    if (s?.error) toast(messageErreur(s.error), 'error');
    else toast(t('redirects.removed', { url: regle.from }), 'success');
  } catch (err) {
    toastError(err);
  } finally {
    redirectAction.onChange?.();
  }
}

// ───────────────────────── L'action, telle que l'écran la voit ─────────────────────────

export const redirectAction = {
  key: 'redirects',
  icon: 'link',
  labelKey: 'actions.redirects',
  hintKey: 'redirects.explain',
  startLabelKey: 'redirects.verify',
  beforeRunKey: 'redirects.before_run',
  batch: 40,
  onChange: null,

  reset() {
    state.plan = null;
    state.selected = null;
    state.done.clear();
  },

  form({ step = 1 } = {}) {
    return h(
      'div',
      { class: 'card p-5' },
      stepTitle(step, t('redirects.step_what'), t('redirects.step_what_hint')),
      formulaire(),
    );
  },

  /** Rien à vérifier tant qu'une paire n'est pas complète et valable. */
  canRun() {
    const regles = reglesSaisies();
    if (!regles.length) return false;
    return regles.every((r) => urlValide(r.from) && urlValide(r.to, { destination: true }) && r.from !== r.to);
  },

  async run(server, domains) {
    const request = Object.fromEntries(domains.map((domain) => [domain, { rules: reglesSaisies() }]));
    if (!Object.keys(request).length) return;
    const out = await api(`/api/servers/${enc(server)}/redirects/plan`, { method: 'POST', body: { request, operation: 'add' } });
    state.plan ??= { sites: [] };
    for (const site of out.sites ?? []) state.plan.sites.push({ ...site, server, serverLabel: server });
    if (!state.selected && state.plan.sites.length) state.selected = keyOf(state.plan.sites[0]);
  },

  stats() {
    const sites = state.plan?.sites ?? [];
    const prets = sites.filter(pret);
    const aPoser = prets.reduce((n, s) => n + s.items.filter((it) => it.state === 'to_add' || it.state === 'conflict').length, 0);
    const deja = prets.reduce((n, s) => n + s.items.filter((it) => it.state === 'present').length, 0);
    const posees = [...state.done.values()].reduce((a, b) => a + b, 0);
    const cells = [
      ['redirects.stat_sites', fmtNum(prets.length), 'text-ink'],
      ['redirects.stat_todo', fmtNum(aPoser), 'text-amber-700'],
      ['redirects.stat_present', fmtNum(deja), 'text-ink-300'],
      ['redirects.stat_done', fmtNum(posees), 'text-accent-700'],
    ];
    const bloques = sites.length - prets.length;
    if (bloques) cells.push(['redirects.stat_blocked', fmtNum(bloques), 'text-red-600']);
    return cells;
  },

  ready: () => Boolean(state.plan?.sites.length),

  results({ permissions = [], openFiles = null } = {}) {
    if (!state.plan?.sites.length) return null;
    return h(
      'div',
      { class: 'space-y-4' },
      barre(permissions),
      h('div', { class: 'grid gap-4 lg:grid-cols-[19rem_1fr]' }, listeSites(), detailSite(permissions, openFiles)),
    );
  },

  finished() {
    const sites = state.plan?.sites ?? [];
    const bloques = sites.filter((s) => !pret(s)).length;
    toast(t('redirects.scan_done', { sites: fmtNum(sites.length - bloques), blocked: fmtNum(bloques) }), bloques ? 'info' : 'success');
  },

  labelServers(labelFor) {
    for (const site of state.plan?.sites ?? []) site.serverLabel = labelFor(site.server);
  },
};

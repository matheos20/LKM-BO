import { api } from './api.js';
import { t } from './i18n.js';
import { closeModal, enc, fmtNum, h, icon, modalHeader, openModal, toast, toastError } from './ui.js';

/**
 * Action « Traduction » : repérer et corriger les textes d'une page d'accueil rédigés
 * dans une autre langue que celle du site.
 *
 * Elle s'adresse à un agent, pas à un développeur. Trois temps :
 *   1. ANALYSER — le back-office lit la page d'accueil des sites choisis et repère les
 *      textes dans la mauvaise langue. Rien n'est modifié.
 *   2. RELIRE  — l'emplacement du texte est nommé en clair (« Bannière — Titre »), la
 *      traduction connue est déjà proposée, et l'agent corrige ce qu'il veut.
 *   3. PUBLIER — l'écriture emprunte le circuit de publication du site : sauvegarde
 *      horodatée, contrôle de syntaxe, relecture de contrôle.
 *
 * Le périmètre, la progression et le bouton de lancement appartiennent à l'écran
 * « Actions » : ce module ne s'occupe que de la traduction elle-même.
 */

const state = {
  sites: [], // sites porteurs d'au moins un texte à traduire, dans l'ordre d'analyse
  failed: [], // sites illisibles
  selected: null, // clé « serveur/domaine »
  edits: new Map(), // clé de site → Map(chemin → { keep, value })
  doneSites: new Map(), // clé de site → nombre de textes publiés
  machine: new Map(), // serveur → traduction automatique disponible
  provider: null, // nom du service retenu : deepl, google, libre
};

const keyOf = (site) => `${site.server}/${site.domain}`;

// ───────────────────────── Emplacements lisibles ─────────────────────────

/**
 * Traduit un chemin de configuration en emplacement compréhensible.
 * « homepage.faq.items.2.q » devient « Questions fréquentes — Question 3 ».
 */
export function whereLabel(path) {
  const parts = String(path ?? '').split('.');
  if (parts[0] === 'site_tagline') return t('translate.where.site_tagline');
  if (parts[0] === 'header_cta_text') return t('translate.where.header_cta_text');
  if (parts[0] !== 'homepage' || parts.length < 2) return path;

  // Champ posé directement sur la page, hors bloc : « homepage.meta_description ».
  if (parts.length === 2) {
    const field = t(`design.field.${parts[1]}`);
    if (!field.startsWith('design.field.')) return field;
  }

  const family = t(`design.family.${parts[1]}`);
  const head = family.startsWith('design.family.') ? parts[1] : family;
  const rest = parts.slice(2);
  if (!rest.length) return head;

  // Élément d'une liste : « items.2.q » ou « features.1 ».
  const idx = rest.findIndex((seg) => /^\d+$/.test(seg));
  if (idx !== -1) {
    const leaf = rest[idx + 1] ?? rest[idx - 1];
    const label = t(`design.field.${leaf}`);
    const name = label.startsWith('design.field.') ? leaf : label;
    return `${head} — ${name} ${Number(rest[idx]) + 1}`;
  }
  const leaf = rest[rest.length - 1];
  const label = t(`design.field.${leaf}`);
  return `${head} — ${label.startsWith('design.field.') ? leaf : label}`;
}

/**
 * Un texte de quatre mots dont deux sont des mots outils communs à deux langues
 * (« en », « de », « je ») peut être mal classé. Ces cas restent affichés — sinon de
 * vrais oublis passeraient à la trappe — mais signalés comme incertains.
 *
 * Deux façons d'être sûr, et il suffit de l'une :
 *   - le texte est DENSE en mots de cette langue : « S'informer, s'instruire,
 *     s'épanouir. » marque 3 sur 3 mots, aucun doute possible malgré sa brièveté ;
 *   - le texte est LONG et devance nettement les autres langues.
 * À l'inverse, « Voyageur en van aménagé » marque 2 sur 4 avec un écart de 1 : les
 * mots « en » et « van » appartiennent aussi au néerlandais. Celui-là se vérifie.
 */
export const uncertainFor = (item) => {
  if (item.source !== 'detected') return false;
  const words = item.words ?? 9;
  const score = item.score ?? 0;
  const gap = item.gap ?? 9;
  const dense = score >= 3 && score / Math.max(1, words) >= 0.4;
  const net = gap >= 2 && words >= 5;
  return !dense && !net;
};

/**
 * Suite des balises d'un texte, dans l'ordre : ['em', '/em'].
 *
 * Une traduction doit porter les mêmes, au même endroit. Sur flashkod.com,
 * « Le hardware, cet <em>écosystème</em> fragile » traduit par
 * « Hardware: That <em>Fragile Ecosystem</em> » garde bien la balise, mais elle a
 * changé de mots : la mise en valeur portait sur un mot, elle en couvre deux, dont
 * l'adjectif qui était dehors. Le site reste valide, la page ne dit plus la même chose.
 */
export const tagSignature = (text) =>
  [...String(text ?? '').matchAll(/<(\/?)([a-zA-Z][\w-]*)/g)].map((m) => `${m[1]}${m[2].toLowerCase()}`);

const sameTags = (a, b) => {
  const x = tagSignature(a);
  const y = tagSignature(b);
  return x.length === y.length && x.every((tag, i) => tag === y[i]);
};

/** Nombre de mots à l'intérieur de chaque paire de balises, dans l'ordre. */
export const innerWords = (text) =>
  [...String(text ?? '').matchAll(/<([a-zA-Z][\w-]*)[^>]*>([\s\S]*?)<\/\1\s*>/g)].map(
    (m) => (m[2].replace(/<[^>]*>/g, ' ').match(/[\p{L}\p{N}]+/gu) ?? []).length,
  );

/**
 * Ce qui cloche entre un texte et sa traduction, ou `null`.
 *
 * Deux défauts se voient sans connaître les deux langues : une balise perdue ou
 * ajoutée, et une balise qui n'entoure plus le même nombre de mots. Le second est
 * le cas de flashkod.com, où <em> couvrait « écosystème » et couvre désormais
 * « Fragile Ecosystem » : la page reste valide, la mise en valeur a changé de sens.
 */
/** « <em> <a> » : les balises du texte d'origine, pour les rappeler à l'agent. */
const tagList = (text) =>
  tagSignature(text)
    .filter((x) => !x.startsWith('/'))
    .map((x) => `<${x}>`)
    .join(' ') || '—';

export function tagIssue(source, target) {
  if (!String(target ?? '').trim()) return null;
  if (!sameTags(source, target)) return 'translate.tags_differ';
  const avant = innerWords(source);
  const apres = innerWords(target);
  return avant.some((n, i) => n !== apres[i]) ? 'translate.tags_moved' : null;
}

const langName = (code) => {
  if (!code) return '—';
  const label = t(`translate.lang.${code}`);
  return label.startsWith('translate.lang.') ? code : label;
};

const countTexts = () => state.sites.reduce((n, s) => n + s.items.length, 0);

const editsFor = (site) => {
  const key = keyOf(site);
  if (!state.edits.has(key)) state.edits.set(key, new Map());
  return state.edits.get(key);
};

function select(site) {
  state.selected = keyOf(site);
  if (site.lock === undefined) loadLock(site);
  const edits = editsFor(site);
  // Première ouverture : la proposition connue est pré-remplie, et seuls les textes
  // pour lesquels une traduction existe sont cochés — l'agent complète les autres.
  for (const item of site.items ?? []) {
    if (!edits.has(item.path)) edits.set(item.path, { keep: Boolean(item.suggestion), value: item.suggestion ?? '' });
  }
}

const current = () => state.sites.find((s) => keyOf(s) === state.selected) ?? null;

/**
 * État de verrouillage du domaine retenu.
 *
 * Un domaine verrouillé refuse toute écriture : publier s'y solderait par une erreur
 * de droits, et l'agent devrait repartir chercher l'écran des domaines. L'état est
 * donc lu à la sélection, et les deux boutons sont là où le travail se fait.
 */
async function loadLock(site) {
  site.lock = { status: null, caps: {}, busy: true };
  try {
    const d = await api(`/api/servers/${enc(site.server)}/domains/${enc(site.domain)}`);
    site.lock = { status: d.status, caps: d.capabilities ?? {}, busy: false };
  } catch {
    // Un domaine dont l'état reste inconnu n'empêche rien : les boutons restent absents.
    site.lock = { status: null, caps: {}, busy: false };
  }
  if (keyOf(site) === state.selected) translateAction.onChange?.();
}

async function toggleLock(site, action, button) {
  button.disabled = true;
  try {
    const out = await api(`/api/servers/${enc(site.server)}/domains/${enc(site.domain)}`, { method: 'PATCH', body: { action } });
    site.lock = { ...site.lock, status: out.status, busy: false };
    toast(t(action === 'lock' ? 'toast.locked' : 'toast.unlocked', { domain: site.domain }), 'success');
  } catch (err) {
    toastError(err);
  } finally {
    button.disabled = false;
    translateAction.onChange?.();
  }
}

/** Les deux boutons, ou rien si le compte n'a pas le droit ou le serveur pas la capacité. */
function lockControls(site, permissions) {
  const lock = site.lock;
  if (!lock || lock.busy || !lock.status) return null;

  const badge = h(
    'span',
    { class: lock.status === 'locked' ? 'badge bg-amber-50 text-amber-700' : 'badge bg-accent-50 text-accent-700' },
    icon(lock.status === 'locked' ? 'lock' : 'unlock', 'size-3.5'),
    t(`status.${lock.status}`),
  );
  if (lock.status === 'incomplete') return badge;

  const action = lock.status === 'locked' ? 'unlock' : 'lock';
  const cap = lock.caps?.[action];
  const allowed = permissions.includes('domains.lock') && cap?.ok !== false;
  const button = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-outline px-2.5 py-1.5 text-xs',
      disabled: !allowed,
      title: allowed ? null : t('action.unavailable', { reason: t(`reason.${cap?.reason ?? 'permission_denied'}`) }),
      onclick: (e) => toggleLock(site, action, e.currentTarget),
    },
    icon(action === 'lock' ? 'lock' : 'unlock', 'size-3.5'),
    t(`action.${action}`),
  );
  return h('span', { class: 'flex items-center gap-2' }, badge, button);
}

// ───────────────────────── Actions sur un site ─────────────────────────

/**
 * Remplit les traductions manquantes d'un site. Renvoie le nombre de textes proposés.
 * Les services de traduction n'acceptent qu'une langue source par appel : les textes
 * sont donc groupés par langue détectée.
 */
async function fillSite(site) {
  const edits = editsFor(site);
  const pending = site.items.filter((it) => !edits.get(it.path)?.value.trim());
  if (!pending.length) return 0;

  const groups = new Map();
  for (const item of pending) {
    const key = item.lang ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  let filled = 0;
  for (const [from, items] of groups) {
    const { translations } = await api(`/api/servers/${enc(site.server)}/translation/translate`, {
      method: 'POST',
      body: { texts: items.map((it) => it.text), from: from || undefined, to: site.lang },
    });
    items.forEach((item, i) => {
      const text = translations?.[i];
      if (!text) return;
      edits.set(item.path, { keep: true, value: text });
      filled += 1;
    });
  }
  return filled;
}

async function machineTranslateSite(site, button) {
  button.disabled = true;
  try {
    const filled = await fillSite(site);
    toast(filled ? t('translate.filled') : t('translate.nothing_to_fill'), filled ? 'success' : 'info');
  } catch (err) {
    toastError(err);
  } finally {
    button.disabled = false;
    translateAction.onChange?.();
  }
}

/**
 * Traduit d'un coup tous les sites qui restent à traiter.
 *
 * C'est le geste qui évite le travail à la main sur un parc entier : l'agent relit
 * ensuite, site par site ou d'un bloc. Rien n'est écrit ici — seules les propositions
 * sont remplies.
 */
async function translateAll(button) {
  const todo = state.sites.filter((s) => !state.doneSites.has(keyOf(s)));
  const label = button.lastChild;
  let filled = 0;
  button.disabled = true;
  try {
    for (const [i, site] of todo.entries()) {
      label.textContent = t('translate.working_site', { done: fmtNum(i + 1), total: fmtNum(todo.length) });
      filled += await fillSite(site);
      // Affichage progressif : l'agent voit les traductions arriver.
      if (keyOf(site) === state.selected) translateAction.onChange?.();
    }
    toast(t('translate.filled_all', { count: fmtNum(filled) }), 'success');
  } catch (err) {
    toastError(err);
  } finally {
    button.disabled = false;
    translateAction.onChange?.();
  }
}

/** Ce qui sera écrit pour un site : coché, rempli, et différent de l'existant. */
function changesFor(site) {
  const edits = editsFor(site);
  return site.items
    .filter((item) => {
      const edit = edits.get(item.path);
      return edit?.keep && edit.value.trim() && edit.value !== item.text;
    })
    .map((item) => ({ path: item.path, from: item.text, to: edits.get(item.path).value.trim() }));
}

async function applySite(site, button) {
  const changes = changesFor(site);
  if (!changes.length) return toast(t('translate.nothing_selected'), 'info');

  button.disabled = true;
  try {
    const out = await api(`/api/servers/${enc(site.server)}/translation/apply`, { method: 'POST', body: { domain: site.domain, changes } });
    state.doneSites.set(keyOf(site), out.applied.length);
    toast(t('translate.applied', { count: fmtNum(out.applied.length), domain: site.domain }), 'success');
    if (out.skipped?.length) toast(t('translate.skipped', { count: fmtNum(out.skipped.length) }), 'info');
    // On enchaîne : l'agent passe au site suivant sans chercher où cliquer.
    const next = state.sites.find((s) => !state.doneSites.has(keyOf(s)));
    if (next) select(next);
  } catch (err) {
    toastError(err);
  } finally {
    button.disabled = false;
    translateAction.onChange?.();
  }
}

/**
 * Publie tous les sites prêts, après confirmation.
 *
 * Une écriture en production ne se déclenche jamais d'un seul clic : la fenêtre
 * annonce le nombre de sites et de textes concernés, et rappelle que chaque site est
 * sauvegardé avant d'être écrit, puis relu. Les sites en échec restent dans la liste.
 */
function publishAll() {
  const todo = state.sites.filter((s) => !state.doneSites.has(keyOf(s)) && changesFor(s).length);
  if (!todo.length) return toast(t('translate.nothing_selected'), 'info');
  const texts = todo.reduce((n, s) => n + changesFor(s).length, 0);

  const go = h('button', { type: 'button', class: 'btn btn-primary' }, icon('save'), t('translate.publish_all_go'));
  go.addEventListener('click', async () => {
    go.disabled = true;
    let ok = 0;
    let ko = 0;
    for (const [i, site] of todo.entries()) {
      go.lastChild.textContent = t('translate.working_site', { done: fmtNum(i + 1), total: fmtNum(todo.length) });
      try {
        const out = await api(`/api/servers/${enc(site.server)}/translation/apply`, { method: 'POST', body: { domain: site.domain, changes: changesFor(site) } });
        state.doneSites.set(keyOf(site), out.applied.length);
        ok += 1;
      } catch (err) {
        ko += 1;
        toastError(err);
      }
    }
    closeModal();
    toast(t('translate.published_all', { ok: fmtNum(ok), ko: fmtNum(ko) }), ko ? 'info' : 'success');
    translateAction.onChange?.();
  });

  openModal(
    h(
      'div',
      {},
      modalHeader(t('translate.publish_all_title'), 'bg-accent-50 text-accent-700', 'save'),
      h('p', { class: 'text-sm text-ink-600' }, t('translate.publish_all_body', { sites: fmtNum(todo.length), texts: fmtNum(texts) })),
      h('p', { class: 'mt-2 text-sm text-ink-500' }, t('translate.safety_note')),
      h(
        'div',
        { class: 'mt-6 flex justify-end gap-2' },
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: closeModal }, t('action.cancel')),
        go,
      ),
    ),
  );
}

// ───────────────────────── Rendu ─────────────────────────

function emptyResult() {
  return h(
    'div',
    { class: 'card px-6 py-16 text-center' },
    h('span', { class: 'mx-auto flex size-12 items-center justify-center rounded-2xl bg-accent-50 text-accent-700' }, icon('check', 'size-6')),
    h('p', { class: 'mt-4 font-semibold' }, t('translate.all_clean')),
    h('p', { class: 'mt-1 text-sm text-ink-500' }, t('translate.all_clean_hint')),
  );
}

/** Liste des sites à gauche, textes du site retenu à droite. */
function siteList(showServer) {
  const rows = state.sites.map((site) => {
    const applied = state.doneSites.get(keyOf(site));
    const active = state.selected === keyOf(site);
    return h(
      'button',
      {
        type: 'button',
        class: `flex w-full items-center gap-3 border-b border-ink-100 px-4 py-3 text-left transition last:border-0 ${active ? 'bg-accent-50' : 'hover:bg-ink-50'}`,
        'aria-current': String(active),
        onclick: () => {
          select(site);
          translateAction.onChange?.();
        },
      },
      h(
        'span',
        { class: 'min-w-0 flex-1' },
        h('span', { class: 'block truncate text-sm font-medium' }, site.domain),
        h(
          'span',
          { class: 'mt-0.5 block truncate text-xs text-ink-400' },
          `${langName(site.lang)} · ${t('translate.texts_count', { count: fmtNum(site.items.length) })}${showServer ? ` · ${site.serverLabel}` : ''}`,
        ),
      ),
      applied != null
        ? h('span', { class: 'badge bg-accent-100 text-accent-700' }, icon('check', 'size-3.5'), fmtNum(applied))
        : h('span', { class: 'badge bg-ink-100 text-ink-600 tabular-nums' }, fmtNum(site.items.length)),
    );
  });

  return h(
    'div',
    { class: 'card overflow-hidden self-start' },
    h('p', { class: 'border-b border-ink-100 bg-ink-50/60 px-4 py-2.5 text-xs font-semibold tracking-wide text-ink-500 uppercase' }, t('translate.sites_to_fix')),
    h('div', { class: 'max-h-[32rem] overflow-y-auto' }, rows.filter(Boolean)),
  );
}

function siteDetail(permissions) {
  const site = current();
  if (!site) return h('div', { class: 'card px-6 py-16 text-center text-ink-400' }, t('translate.pick_site'));

  const can = (perm) => permissions.includes(perm);
  const edits = editsFor(site);
  const applied = state.doneSites.get(keyOf(site));

  const header = h(
    'div',
    { class: 'flex flex-wrap items-center gap-3 border-b border-ink-100 px-5 py-4' },
    h(
      'div',
      { class: 'min-w-0 flex-1' },
      h(
        'div',
        { class: 'flex flex-wrap items-center gap-2' },
        h('h3', { class: 'truncate font-semibold' }, site.domain),
        h('span', { class: 'badge bg-ink-100 text-ink-700' }, langName(site.lang)),
        h('span', { class: 'badge bg-ink-50 text-ink-500' }, site.serverLabel),
        applied != null ? h('span', { class: 'badge bg-accent-100 text-accent-700' }, icon('check', 'size-3.5'), t('translate.applied_badge')) : null,
      ),
      h('p', { class: 'mt-1 text-xs text-ink-400' }, t(`translate.source.${site.langSource}`, { hint: site.hint || '—' })),
    ),
    lockControls(site, permissions),
    state.machine.get(site.server) && can('design.edit')
      ? h('button', { type: 'button', class: 'btn btn-outline', onclick: (e) => machineTranslateSite(site, e.currentTarget) }, icon('wrench'), h('span', {}, t('translate.autofill')))
      : null,
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn-primary',
        disabled: !can('design.publish'),
        title: can('design.publish') ? null : t('reason.permission_denied'),
        onclick: (e) => applySite(site, e.currentTarget),
      },
      icon('save'),
      t('translate.apply'),
    ),
  );

  return h(
    'div',
    { class: 'card overflow-hidden' },
    header,
    h('div', { class: 'divide-y divide-ink-100' }, site.items.map((item) => textRow(site, item, edits))),
    h('p', { class: 'border-t border-ink-100 bg-ink-50/60 px-5 py-3 text-xs text-ink-500' }, t('translate.safety_note')),
  );
}

/** Une ligne = un texte : où il se trouve, ce qu'il dit, ce qu'il va devenir. */
function textRow(site, item, edits) {
  const edit = edits.get(item.path) ?? { keep: false, value: '' };
  const long = item.text.length > 90;

  const field = h(long ? 'textarea' : 'input', {
    class: 'input',
    rows: long ? '3' : null,
    value: long ? null : edit.value,
    placeholder: t('translate.placeholder', { lang: langName(site.lang) }),
    oninput: (e) => {
      const now = edits.get(item.path) ?? { keep: true, value: '' };
      edits.set(item.path, { keep: now.keep || Boolean(e.target.value.trim()), value: e.target.value });
      const row = e.target.closest('[data-row]');
      const box = row?.querySelector('input[type=checkbox]');
      if (box && e.target.value.trim()) box.checked = true;
      // Contrôle à la frappe : redessiner la ligne ferait sauter le curseur.
      const alerte = row?.querySelector('[data-tags]');
      if (alerte) {
        const souci = tagIssue(item.text, e.target.value);
        alerte.hidden = !souci;
        if (souci) alerte.lastChild.textContent = t(souci, { tags: tagList(item.text) });
      }
    },
  });
  if (long) field.value = edit.value;

  const keep = h('input', {
    type: 'checkbox',
    class: 'size-4 rounded border-ink-300 text-accent focus:ring-accent',
    checked: edit.keep,
    'aria-label': t('translate.keep'),
    onchange: (e) => {
      const now = edits.get(item.path) ?? { keep: false, value: '' };
      edits.set(item.path, { ...now, keep: e.target.checked });
    },
  });

  return h(
    'div',
    { class: 'grid gap-3 px-5 py-4 lg:grid-cols-2', 'data-row': item.path },
    h(
      'div',
      { class: 'min-w-0' },
      h(
        'div',
        { class: 'flex flex-wrap items-center gap-2' },
        h('span', { class: 'text-sm font-semibold' }, whereLabel(item.path)),
        item.source === 'dictionary'
          ? h('span', { class: 'badge bg-accent-50 text-accent-700' }, t('translate.source_dictionary'))
          : uncertainFor(item)
            ? h('span', { class: 'badge bg-ink-100 text-ink-600', title: t('translate.uncertain_hint') }, t('translate.uncertain', { lang: langName(item.lang) }))
            : h('span', { class: 'badge bg-amber-50 text-amber-700' }, t('translate.detected', { lang: langName(item.lang) })),
      ),
      h('p', { class: 'mt-1.5 rounded-lg bg-ink-50 px-3 py-2 text-sm text-ink-700' }, item.text),
      h('p', { class: 'mt-1 font-mono text-[11px] text-ink-300' }, item.path),
    ),
    h(
      'div',
      { class: 'min-w-0' },
      h(
        'div',
        { class: 'mb-1.5 flex items-center justify-between gap-2' },
        h('span', { class: 'text-xs font-semibold tracking-wide text-ink-500 uppercase' }, t('translate.new_text')),
        h('label', { class: 'flex items-center gap-2 text-xs text-ink-500' }, keep, t('translate.keep')),
      ),
      field,
      h(
        'p',
        { class: 'mt-1 flex items-start gap-1.5 text-xs text-amber-700', 'data-tags': '', hidden: !tagIssue(item.text, edit.value) },
        icon('alert', 'mt-0.5 size-3.5 shrink-0'),
        h('span', {}, t(tagIssue(item.text, edit.value) ?? 'translate.tags_differ', { tags: tagList(item.text) })),
      ),
      item.suggestion ? h('p', { class: 'mt-1 text-xs text-accent-700' }, t('translate.from_dictionary')) : null,
    ),
  );
}

/**
 * Traiter tout le lot d'un coup : c'est ce qui distingue un outil de parc d'un
 * éditeur. Les deux gestes restent séparés — proposer les traductions, puis les
 * publier — pour qu'une relecture puisse s'intercaler.
 */
function bulkBar(permissions) {
  const can = (perm) => permissions.includes(perm);
  const reste = state.sites.filter((s) => !state.doneSites.has(keyOf(s)));
  const prets = reste.filter((s) => changesFor(s).length);
  const machine = [...state.machine.values()].some(Boolean);

  return h(
    'div',
    { class: 'card flex flex-wrap items-center gap-3 px-5 py-3' },
    h(
      'p',
      { class: 'min-w-0 flex-1 text-sm text-ink-500' },
      t('translate.bulk_hint', { sites: fmtNum(reste.length), ready: fmtNum(prets.length) }),
      state.provider ? h('span', { class: 'badge ml-2 bg-ink-100 text-ink-600' }, t(`translate.provider_${state.provider}`)) : null,
    ),
    machine && can('design.edit')
      ? h(
          'button',
          { type: 'button', class: 'btn btn-outline', disabled: !reste.length, onclick: (e) => translateAll(e.currentTarget) },
          icon('wrench'),
          h('span', {}, t('translate.translate_all')),
        )
      : // Sans service configuré, l'absence de bouton laissait l'agent sans explication.
        h('p', { class: 'basis-full text-xs text-ink-400 lg:basis-auto' }, t('translate.no_provider')),
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn-primary',
        disabled: !prets.length || !can('design.publish'),
        title: can('design.publish') ? null : t('reason.permission_denied'),
        onclick: publishAll,
      },
      icon('save'),
      h('span', {}, t('translate.publish_all', { count: fmtNum(prets.length) })),
    ),
  );
}

// ───────────────────────── L'action, telle que l'écran la voit ─────────────────────────

export const translateAction = {
  key: 'translate',
  icon: 'globe',
  labelKey: 'actions.translate',
  hintKey: 'translate.explain',
  batch: 100,
  /** Appelé par l'écran quand le rendu doit être refait. */
  onChange: null,

  reset() {
    state.sites = [];
    state.failed = [];
    state.selected = null;
    state.edits.clear();
    state.doneSites.clear();
  },

  /** Analyse un lot de domaines d'un même serveur. Ne modifie rien. */
  async run(server, domains) {
    if (!state.machine.has(server)) {
      const status = await api(`/api/servers/${enc(server)}/translation/status`).catch(() => ({ machine: false }));
      state.machine.set(server, Boolean(status.machine));
      state.provider ??= status.provider ?? null;
    }
    const label = server;
    const { sites } = await api(`/api/servers/${enc(server)}/translation/scan`, { method: 'POST', body: { domains } });
    for (const site of sites ?? []) {
      const entry = { ...site, server, serverLabel: label };
      if (site.error) state.failed.push(entry);
      else if (site.items?.length) state.sites.push(entry);
    }
    if (!state.selected && state.sites.length) select(state.sites[0]);
  },

  stats() {
    const published = [...state.doneSites.values()].reduce((a, b) => a + b, 0);
    return [
      ['translate.stat_sites', fmtNum(state.sites.length), 'text-accent-700'],
      ['translate.stat_texts', fmtNum(countTexts()), 'text-ink'],
      ['translate.stat_applied', fmtNum(published), 'text-accent-700'],
      ['translate.stat_failed', fmtNum(state.failed.length), state.failed.length ? 'text-red-600' : 'text-ink-300'],
    ];
  },

  results({ permissions = [] } = {}) {
    if (!state.sites.length) return null;
    const multi = new Set(state.sites.map((s) => s.server)).size > 1;
    return h(
      'div',
      { class: 'space-y-4' },
      bulkBar(permissions),
      h('div', { class: 'grid gap-4 lg:grid-cols-[19rem_1fr]' }, siteList(multi), siteDetail(permissions)),
    );
  },

  /** Rien trouvé : le dire franchement plutôt que de laisser un écran vide. */
  emptyState: () => emptyResult(),

  finished() {
    toast(t('translate.scan_done', { sites: fmtNum(state.sites.length), texts: fmtNum(countTexts()) }), 'success');
  },

  /** Le libellé du serveur n'est connu que de l'écran : il le pose après coup. */
  labelServers(labelFor) {
    for (const site of [...state.sites, ...state.failed]) site.serverLabel = labelFor(site.server);
  },
};

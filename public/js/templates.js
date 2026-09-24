import { api } from './api.js';
import { t } from './i18n.js';
import { closeModal, enc, fmtNum, folderButton, h, icon, modalHeader, openModal, toast, toastError } from './ui.js';

/**
 * Action « Gabarits » : les mots visibles restés en français dans les fichiers du
 * moteur d'un site — `parts/`, `404.php`, `sitemap.php`…
 *
 * Elle ne ressemble pas à l'action « page d'accueil », et c'est voulu : ici, chaque
 * correction vient d'un dictionnaire exact ou du lexique du site (`parts/lang.php`).
 * Il n'y a donc rien à rédiger, rien à relire mot à mot — seulement à confirmer. Les
 * cases sont cochées d'office, et le geste courant est « corriger tous les sites ».
 *
 * Ce que l'action ne touche jamais : le contenu des articles (ils ont leur éditeur),
 * les adresses (traduire un lien change sa destination), et les tables multilingues
 * des gabarits, qui contiennent toutes les langues par construction.
 */

const state = {
  sites: [], // sites porteurs d'au moins une correction
  skipped: 0, // sites français : rien à traduire vers leur propre langue
  noLexicon: 0, // sites sans parts/lang.php
  selected: null,
  edits: new Map(), // clé de site → Set des corrections écartées
  doneSites: new Map(), // clé de site → nombre de fichiers corrigés
  todo: [], // phrases françaises qu'aucun dictionnaire ne couvre
  phrases: [], // dictionnaire ajouté par les agents
  showDict: false,
  prefill: null, // mot repris d'un signalement, pour n'avoir plus qu'à écrire la traduction
};

const keyOf = (site) => `${site.server}/${site.domain}`;
const idOf = (item) => `${item.file}:${item.line}:${item.from}`;

const countItems = () => state.sites.reduce((n, s) => n + s.items.length, 0);
const current = () => state.sites.find((s) => keyOf(s) === state.selected) ?? null;

const skipped = (site) => {
  const key = keyOf(site);
  if (!state.edits.has(key)) state.edits.set(key, new Set());
  return state.edits.get(key);
};

/** Corrections retenues pour un site, au format attendu par le serveur. */
function changesFor(site) {
  const hors = skipped(site);
  const parFichier = {};
  for (const item of site.items) {
    if (hors.has(idOf(item))) continue;
    (parFichier[item.file] ??= []).push({ line: item.line, from: item.from });
  }
  return Object.keys(parFichier).length ? parFichier : null;
}

const kindLabel = (kind) => {
  const label = t(`templates.kind_${kind}`);
  return label.startsWith('templates.kind_') ? kind : label;
};

// ───────────────────────── Dictionnaire des agents ─────────────────────────

async function loadPhrases() {
  try {
    const { phrases } = await api('/api/design/phrases');
    state.phrases = phrases ?? [];
  } catch {
    state.phrases = [];
  }
  templateAction.onChange?.();
}

async function addPhrase({ source, lang, target }, bouton) {
  if (bouton) bouton.disabled = true;
  try {
    await api('/api/design/phrases', { method: 'POST', body: { source, lang, target } });
    state.prefill = null;
    toast(t('templates.phrase_added'), 'success');
    await loadPhrases();
  } catch (err) {
    toastError(err);
  } finally {
    if (bouton) bouton.disabled = false;
  }
}

async function removePhrase(id) {
  try {
    await api(`/api/design/phrases/${id}`, { method: 'DELETE' });
    await loadPhrases();
  } catch (err) {
    toastError(err);
  }
}

/** Formulaire d'ajout : un mot français, une langue, sa traduction. */
function phraseForm({ source = '', lang = 'UK' } = {}) {
  const fr = h('input', { class: 'input sm:w-64', value: source, placeholder: t('templates.phrase_source') });
  const choix = h(
    'select',
    { class: 'input sm:w-32' },
    ['UK', 'ES', 'PT', 'DE', 'IT', 'NL'].map((l) => h('option', { value: l }, l)),
  );
  choix.value = lang; // la propriété, pas l'attribut : c'est elle qui choisit l'option
  const to = h('input', { class: 'input sm:w-64', placeholder: t('templates.phrase_target') });
  const go = h(
    'button',
    { type: 'button', class: 'btn btn-primary px-3 py-1.5' },
    icon('plus'),
    t('templates.phrase_add'),
  );
  go.addEventListener('click', () => addPhrase({ source: fr.value, lang: choix.value, target: to.value }, go));
  to.addEventListener('keydown', (e) => e.key === 'Enter' && go.click());
  return h('div', { class: 'flex flex-wrap items-center gap-2', 'data-dict-form': '' }, fr, choix, to, go);
}

/** Le dictionnaire, replié par défaut : on l'ouvre pour ajouter ou retirer un mot. */
function dictionary(permissions) {
  const peut = permissions.includes('design.edit');
  const entete = h(
    'button',
    {
      type: 'button',
      class: 'flex w-full items-center gap-2 px-5 py-3 text-left',
      onclick: () => {
        state.showDict = !state.showDict;
        if (state.showDict && !state.phrases.length) loadPhrases();
        templateAction.onChange?.();
      },
    },
    icon('chevronRight', `size-4 text-ink-400 transition ${state.showDict ? 'rotate-90' : ''}`),
    h('span', { class: 'text-sm font-semibold' }, t('templates.dict_title')),
    h('span', { class: 'badge bg-ink-100 text-ink-600' }, fmtNum(state.phrases.length)),
    h('span', { class: 'flex-1' }),
    h('span', { class: 'text-xs text-ink-400' }, t('templates.dict_hint')),
  );
  if (!state.showDict) return h('div', { class: 'card overflow-hidden' }, entete);

  const lignes = state.phrases.map((ph) =>
    h(
      'div',
      { class: 'flex items-center gap-3 border-t border-ink-100 px-5 py-2 text-sm' },
      h('span', { class: 'min-w-0 flex-1 truncate' }, ph.source),
      icon('arrowRight', 'size-3.5 shrink-0 text-ink-300'),
      h('span', { class: 'min-w-0 flex-1 truncate font-medium text-accent-700' }, ph.target),
      h('span', { class: 'badge bg-ink-50 text-ink-500' }, ph.lang),
      peut ? h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('action.delete'), onclick: () => removePhrase(ph.id) }, icon('trash')) : null,
    ),
  );

  return h(
    'div',
    { class: 'card overflow-hidden' },
    entete,
    peut ? h('div', { class: 'border-t border-ink-100 bg-ink-50/60 px-5 py-3' }, phraseForm(state.prefill ?? {})) : null,
    lignes.length ? h('div', {}, lignes) : h('p', { class: 'border-t border-ink-100 px-5 py-4 text-sm text-ink-400' }, t('templates.dict_empty')),
  );
}

/** Ce que l'analyse n'a pas su traduire : à l'agent d'ajouter le mot, ou de laisser. */
function todoList(permissions) {
  if (!state.todo.length) return null;
  const peut = permissions.includes('design.edit');
  const lignes = state.todo.slice(0, 40).map((ligne) =>
    h(
      'div',
      { class: 'flex flex-wrap items-center gap-3 border-t border-ink-100 px-5 py-2.5 text-sm' },
      h('span', { class: 'min-w-0 flex-1' }, ligne.text),
      h('span', { class: 'font-mono text-[11px] text-ink-400' }, `${ligne.domain} · ${ligne.file}:${ligne.line}`),
      ligne.count > 1 ? h('span', { class: 'badge bg-ink-100 text-ink-600' }, t('templates.todo_times', { count: fmtNum(ligne.count) })) : null,
      peut
        ? h(
            'button',
            {
              type: 'button',
              class: 'btn btn-outline px-2.5 py-1 text-xs',
              onclick: () => {
                // Le formulaire se rouvre pré-rempli : il ne reste que la traduction à écrire.
                state.prefill = { source: ligne.text, lang: ligne.lang ?? 'UK' };
                state.showDict = true;
                if (!state.phrases.length) loadPhrases();
                templateAction.onChange?.();
                setTimeout(() => document.querySelectorAll('#actions-view [data-dict-form] input')[1]?.focus(), 30);
              },
            },
            icon('plus', 'size-3.5'),
            t('templates.todo_add'),
          )
        : null,
    ),
  );

  return h(
    'div',
    { class: 'card overflow-hidden' },
    h(
      'div',
      { class: 'flex items-center gap-2 px-5 py-3' },
      icon('alert', 'size-4 text-amber-600'),
      h('span', { class: 'text-sm font-semibold' }, t('templates.todo_title')),
      h('span', { class: 'badge bg-amber-50 text-amber-700' }, fmtNum(state.todo.length)),
      h('span', { class: 'flex-1' }),
      h('span', { class: 'text-xs text-ink-400' }, t('templates.todo_hint')),
    ),
    h('div', {}, lignes),
  );
}

// ───────────────────────── Écriture ─────────────────────────

async function applySites(liste, button, label) {
  const changes = {};
  const parServeur = new Map();
  for (const site of liste) {
    const c = changesFor(site);
    if (!c) continue;
    if (!parServeur.has(site.server)) parServeur.set(site.server, []);
    parServeur.get(site.server).push(site);
    changes[site.domain] = c;
  }
  if (!parServeur.size) return toast(t('templates.nothing_selected'), 'info');

  button.disabled = true;
  let fichiers = 0;
  let echecs = 0;
  try {
    let faits = 0;
    for (const [server, sitesDuServeur] of parServeur) {
      // Un lot par serveur, comme pour l'analyse : une machine à la fois.
      for (let i = 0; i < sitesDuServeur.length; i += 40) {
        const lot = sitesDuServeur.slice(i, i + 40);
        const sous = Object.fromEntries(lot.map((s) => [s.domain, changes[s.domain]]));
        const out = await api(`/api/servers/${enc(server)}/translation/templates/apply`, { method: 'POST', body: { changes: sous } });
        for (const res of out.sites ?? []) {
          const site = lot.find((s) => s.domain === res.domain);
          if (!site) continue;
          fichiers += res.written?.length ?? 0;
          echecs += res.failed?.length ?? 0;
          if (res.written?.length) state.doneSites.set(keyOf(site), res.written.length);
        }
        faits += lot.length;
        if (label) label.textContent = t('templates.working', { done: fmtNum(faits), total: fmtNum(liste.length) });
        templateAction.onChange?.();
      }
    }
    toast(t('templates.applied', { files: fmtNum(fichiers), sites: fmtNum(state.doneSites.size) }), echecs ? 'info' : 'success');
    if (echecs) toast(t('templates.failed', { count: fmtNum(echecs) }), 'error');
  } catch (err) {
    toastError(err);
  } finally {
    button.disabled = false;
    templateAction.onChange?.();
  }
}

/** Corriger tous les sites d'un coup : le geste courant, avec confirmation. */
function applyAll() {
  const todo = state.sites.filter((s) => !state.doneSites.has(keyOf(s)) && changesFor(s));
  if (!todo.length) return toast(t('templates.nothing_selected'), 'info');
  const textes = todo.reduce((n, s) => n + s.items.length, 0);

  const go = h('button', { type: 'button', class: 'btn btn-primary' }, icon('save'), h('span', {}, t('templates.apply_all_go')));
  go.addEventListener('click', async () => {
    await applySites(todo, go, go.lastChild);
    closeModal();
  });

  openModal(
    h(
      'div',
      {},
      modalHeader(t('templates.apply_all_title'), 'bg-accent-50 text-accent-700', 'code'),
      h('p', { class: 'text-sm text-ink-600' }, t('templates.apply_all_body', { sites: fmtNum(todo.length), texts: fmtNum(textes) })),
      h('p', { class: 'mt-2 text-sm text-ink-500' }, t('templates.safety_note')),
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

function siteList(showServer) {
  const rows = state.sites.map((site) => {
    const done = state.doneSites.get(keyOf(site));
    const active = state.selected === keyOf(site);
    return h(
      'button',
      {
        type: 'button',
        class: `flex w-full items-center gap-3 border-b border-ink-100 px-4 py-3 text-left transition last:border-0 ${active ? 'bg-accent-50' : 'hover:bg-ink-50'}`,
        'aria-current': String(active),
        onclick: () => {
          state.selected = keyOf(site);
          templateAction.onChange?.();
        },
      },
      h(
        'span',
        { class: 'min-w-0 flex-1' },
        h('span', { class: 'block truncate text-sm font-medium' }, site.domain),
        h('span', { class: 'mt-0.5 block truncate text-xs text-ink-400' }, `${site.lang ?? '—'}${showServer ? ` · ${site.serverLabel}` : ''}`),
      ),
      done != null
        ? h('span', { class: 'badge bg-accent-100 text-accent-700' }, icon('check', 'size-3.5'), fmtNum(done))
        : h('span', { class: 'badge bg-ink-100 text-ink-600 tabular-nums' }, fmtNum(site.items.length)),
    );
  });

  return h(
    'div',
    { class: 'card overflow-hidden self-start' },
    h('p', { class: 'border-b border-ink-100 bg-ink-50/60 px-4 py-2.5 text-xs font-semibold tracking-wide text-ink-500 uppercase' }, t('templates.sites_to_fix')),
    h('div', { class: 'max-h-[32rem] overflow-y-auto' }, rows),
  );
}

function siteDetail(permissions, openFilesFor) {
  const site = current();
  if (!site) return h('div', { class: 'card px-6 py-16 text-center text-ink-400' }, t('templates.pick_site'));
  const hors = skipped(site);
  const done = state.doneSites.get(keyOf(site));

  const rows = site.items.map((item) => {
    const retenu = !hors.has(idOf(item));
    return h(
      'label',
      { class: 'flex cursor-pointer items-start gap-3 px-5 py-3 transition hover:bg-ink-50' },
      h('input', {
        type: 'checkbox',
        class: 'mt-0.5 size-4 rounded border-ink-300 text-accent focus:ring-accent',
        checked: retenu,
        onchange: (e) => {
          if (e.target.checked) hors.delete(idOf(item));
          else hors.add(idOf(item));
          templateAction.onChange?.();
        },
      }),
      h(
        'span',
        { class: 'min-w-0 flex-1' },
        h(
          'span',
          { class: 'flex flex-wrap items-baseline gap-2 text-sm' },
          h('span', { class: 'text-ink-500 line-through' }, item.from),
          icon('arrowRight', 'size-3.5 shrink-0 text-ink-300'),
          h('span', { class: 'font-medium text-accent-700' }, item.to),
        ),
        h(
          'span',
          { class: 'mt-0.5 flex items-center gap-2 font-mono text-[11px] text-ink-400' },
          `${item.file}:${item.line}`,
          h('span', { class: 'badge bg-ink-50 text-ink-500' }, kindLabel(item.kind)),
        ),
      ),
    );
  });

  return h(
    'div',
    { class: 'card overflow-hidden' },
    h(
      'div',
      { class: 'flex flex-wrap items-center gap-3 border-b border-ink-100 px-5 py-4' },
      h(
        'div',
        { class: 'min-w-0 flex-1' },
        h(
          'div',
          { class: 'flex flex-wrap items-center gap-2' },
          h('h3', { class: 'truncate font-semibold' }, site.domain),
          h('span', { class: 'badge bg-ink-100 text-ink-700' }, site.lang ?? '—'),
          h('span', { class: 'badge bg-ink-50 text-ink-500' }, site.serverLabel),
          done != null ? h('span', { class: 'badge bg-accent-100 text-accent-700' }, icon('check', 'size-3.5'), t('templates.done_badge')) : null,
        ),
        h('p', { class: 'mt-1 text-xs text-ink-400' }, t('templates.from_lexicon')),
      ),
      // Les gabarits touchent des fichiers que l'agent ne voit pas depuis le
      // navigateur : le dossier est le seul endroit où il peut les relire.
      folderButton(permissions, openFilesFor && (() => openFilesFor(site))),
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-primary',
          disabled: !permissions.includes('design.publish'),
          title: permissions.includes('design.publish') ? null : t('reason.permission_denied'),
          onclick: (e) => applySites([site], e.currentTarget),
        },
        icon('save'),
        t('templates.apply_site'),
      ),
    ),
    h('div', { class: 'divide-y divide-ink-100' }, rows),
    h('p', { class: 'border-t border-ink-100 bg-ink-50/60 px-5 py-3 text-xs text-ink-500' }, t('templates.safety_note')),
  );
}

function bulkBar(permissions) {
  const reste = state.sites.filter((s) => !state.doneSites.has(keyOf(s)));
  return h(
    'div',
    { class: 'card flex flex-wrap items-center gap-3 px-5 py-3' },
    h('p', { class: 'min-w-0 flex-1 text-sm text-ink-500' }, t('templates.bulk_hint', { sites: fmtNum(reste.length), texts: fmtNum(countItems()) })),
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn-primary',
        disabled: !reste.length || !permissions.includes('design.publish'),
        title: permissions.includes('design.publish') ? null : t('reason.permission_denied'),
        onclick: applyAll,
      },
      icon('save'),
      h('span', {}, t('templates.apply_all', { count: fmtNum(reste.length) })),
    ),
  );
}

// ───────────────────────── L'action, telle que l'écran la voit ─────────────────────────

export const templateAction = {
  key: 'templates',
  icon: 'code',
  labelKey: 'actions.templates',
  hintKey: 'templates.explain',
  batch: 100,
  onChange: null,

  reset() {
    state.sites = [];
    state.todo = [];
    state.skipped = 0;
    state.noLexicon = 0;
    state.selected = null;
    state.edits.clear();
    state.doneSites.clear();
  },

  async run(server, domains) {
    const { sites } = await api(`/api/servers/${enc(server)}/translation/templates`, { method: 'POST', body: { domains } });
    for (const site of sites ?? []) {
      if (site.skip === 'source') state.skipped += 1;
      else if (site.skip === 'lexicon') state.noLexicon += 1;
      else if (site.items?.length) state.sites.push({ ...site, server, serverLabel: server });
      // Ce qu'aucun dictionnaire ne sait traduire : regroupé par texte, avec un exemple
      // de site, pour que l'agent décide une fois pour tout le parc.
      for (const ligne of site.todo ?? []) {
        const vu = state.todo.find((x) => x.text === ligne.text);
        if (vu) vu.count += 1;
        else state.todo.push({ text: ligne.text, file: ligne.file, line: ligne.line, domain: site.domain, lang: site.lang, count: 1 });
      }
    }
    if (!state.selected && state.sites.length) state.selected = keyOf(state.sites[0]);
  },

  stats() {
    const done = [...state.doneSites.values()].reduce((a, b) => a + b, 0);
    const cells = [
      ['templates.stat_sites', fmtNum(state.sites.length), 'text-accent-700'],
      ['templates.stat_texts', fmtNum(countItems()), 'text-ink'],
      ['templates.stat_written', fmtNum(done), 'text-accent-700'],
      ['templates.stat_source', fmtNum(state.skipped), 'text-ink-300', 'templates.stat_source_hint'],
    ];
    if (state.noLexicon) cells.push(['templates.stat_nolex', fmtNum(state.noLexicon), 'text-red-600']);
    return cells;
  },

  ready: () => state.sites.length > 0,

  results({ permissions = [], openFiles = null } = {}) {
    if (!state.sites.length && !state.todo.length) return null;
    const multi = new Set(state.sites.map((s) => s.server)).size > 1;
    return h(
      'div',
      { class: 'space-y-4' },
      state.sites.length ? bulkBar(permissions) : null,
      state.sites.length ? h('div', { class: 'grid gap-4 lg:grid-cols-[19rem_1fr]' }, siteList(multi), siteDetail(permissions, openFiles)) : null,
      todoList(permissions),
      dictionary(permissions),
    );
  },

  emptyState: () =>
    h(
      'div',
      { class: 'card px-6 py-16 text-center' },
      h('span', { class: 'mx-auto flex size-12 items-center justify-center rounded-2xl bg-accent-50 text-accent-700' }, icon('check', 'size-6')),
      h('p', { class: 'mt-4 font-semibold' }, t('templates.all_clean')),
      h('p', { class: 'mt-1 text-sm text-ink-500' }, t('templates.all_clean_hint')),
    ),

  finished() {
    toast(t('templates.scan_done', { sites: fmtNum(state.sites.length), texts: fmtNum(countItems()) }), 'success');
  },

  labelServers(labelFor) {
    for (const site of state.sites) site.serverLabel = labelFor(site.server);
  },
};

import { api } from './api.js';
import { t } from './i18n.js';
import { closeModal, enc, fmtNum, h, icon, modalHeader, openModal, stepTitle, toast, toastError } from './ui.js';

/**
 * Action « Ajouter des rubriques ».
 *
 * Elle s'adresse à un agent qui ne connaît rien aux fichiers : on ne parle ici que de
 * rubriques et d'adresses, jamais de dossier, de slug ni de configuration. Le parcours
 * est en trois temps, dans l'ordre, et la vérification est obligatoire : on ne crée
 * jamais sans avoir montré ce qui va être créé.
 *
 *   1. LES RUBRIQUES — les mêmes pour tous les sites, ou un tableau collé depuis un
 *      tableur quand chaque site a les siennes.
 *   2. LES SITES — le périmètre habituel de l'écran (un serveur, tout le parc, une
 *      liste). En mode tableau, les sites viennent du tableau lui-même.
 *   3. VÉRIFIER, puis CRÉER.
 *
 * Une rubrique du parc tient en trois pièces — un dossier, une ligne de configuration,
 * une ligne dans le résumé WordPress — et la vérification les montre séparément :
 * c'est ce qui permet de rattraper un site à moitié fait sans rien casser ailleurs.
 */

const MAX_RUBRIQUES = 12;

const state = {
  operation: 'add', // add | remove
  mode: 'simple', // simple | table
  rubriques: [''], // mode simple : les noms saisis
  texte: '', // mode tableau : ce que l'agent colle
  parse: null, // { lignes: [{domain, noms}], inconnus: [] }
  cibles: null, // où vivent les domaines collés : { found, unknown, offline }
  resolving: false,
  plan: null, // résultat de la vérification
  selected: null,
  done: new Map(), // clé de site → nombre de rubriques créées
};

/** Nom de rubrique → adresse. Même règle que côté serveur, qui a le dernier mot. */
export function slugify(name) {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[’']/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Une ligne collée : « exemple.com, Sport, Cuisine » ou séparée par des tabulations. */
export function parseTable(texte) {
  const lignes = [];
  const inconnus = [];
  for (const brut of String(texte ?? '').split(/\r?\n/)) {
    const cellules = brut
    // Une ligne tabulée vient d'un fichier : ses cellules sont déjà découpées, et une
    // virgule à l'intérieur appartient au nom. Sinon, l'agent a tapé à la main.
      .split(brut.includes('\t') ? /\t/ : /[;,]/)
      .map((c) => c.trim())
      .filter(Boolean);
    if (!cellules.length) continue;
    const domain = cellules[0]
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/[/?#].*$/, '');
    if (!/^[a-z0-9][a-z0-9.-]{1,252}$/.test(domain) || !domain.includes('.')) {
      inconnus.push(cellules[0].slice(0, 60));
      continue;
    }
    const noms = cellules.slice(1).slice(0, MAX_RUBRIQUES);
    if (noms.length) lignes.push({ domain, noms });
  }
  return { lignes, inconnus };
}

/**
 * Lit un CSV comme un tableur l'écrit : séparateur virgule, point-virgule ou
 * tabulation, champs entre guillemets — « Sport, loisirs » compte pour une seule
 * rubrique — et une éventuelle ligne d'en-tête, reconnue à ce que sa première cellule
 * n'est pas un domaine.
 */
export function parseCsv(texte) {
  const lignes = [];
  let champ = '';
  let courante = [];
  let entreGuillemets = false;
  const contenu = String(texte ?? '').replace(/^\uFEFF/, '');
  const separateur = (contenu.match(/;/g)?.length ?? 0) > (contenu.match(/,/g)?.length ?? 0) ? ';' : ',';

  const finChamp = () => {
    courante.push(champ.trim());
    champ = '';
  };
  const finLigne = () => {
    finChamp();
    if (courante.some(Boolean)) lignes.push(courante);
    courante = [];
  };

  for (let i = 0; i < contenu.length; i += 1) {
    const c = contenu[i];
    if (entreGuillemets) {
      if (c === '"' && contenu[i + 1] === '"') {
        champ += '"';
        i += 1;
      } else if (c === '"') entreGuillemets = false;
      else champ += c;
      continue;
    }
    if (c === '"') entreGuillemets = true;
    else if (c === separateur || c === '\t') finChamp();
    else if (c === '\n') finLigne();
    else if (c !== '\r') champ += c;
  }
  finLigne();

  // Ligne d'en-tête : sa première cellule ne ressemble pas à un domaine.
  if (lignes.length && !/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(lignes[0][0] ?? '')) lignes.shift();
  // Remontées par des TABULATIONS : une rubrique peut contenir une virgule
  // (« Cuisine, recettes »), le fichier l'avait protégée par des guillemets, et la
  // relecture ne doit pas la couper en deux.
  return lignes.map((cellules) => cellules.filter(Boolean).join('\t')).join('\n');
}

const keyOf = (site) => `${site.server}/${site.domain}`;
const nomsSaisis = () => state.rubriques.map((n) => n.trim()).filter(Boolean);

/** La demande envoyée au serveur : domaine → rubriques. */
function demande(targets) {
  if (state.mode === 'table') {
    const out = {};
    for (const ligne of state.parse?.lignes ?? []) {
      if (!targets.some((x) => x.domain === ligne.domain)) continue;
      out[ligne.domain] = ligne.noms.map((name) => ({ name, slug: slugify(name) }));
    }
    return out;
  }
  const rubriques = nomsSaisis().map((name) => ({ name, slug: slugify(name) }));
  return Object.fromEntries(targets.map((x) => [x.domain, rubriques]));
}

// ───────────────────────── Étape 1 : les rubriques ─────────────────────────

let zoneTable = null;

function champRubrique(index) {
  const valeur = state.rubriques[index] ?? '';
  const slug = slugify(valeur);
  const champ = h('input', {
    class: 'input sm:w-72',
    value: valeur,
    placeholder: t('categories.name_placeholder'),
    oninput: (e) => {
      state.rubriques[index] = e.target.value;
      const apercu = e.target.closest('[data-rubrique]')?.querySelector('[data-adresse]');
      if (apercu) apercu.textContent = slugify(e.target.value) ? `/${slugify(e.target.value)}/` : '';
    },
  });

  return h(
    'div',
    { class: 'flex items-center gap-3', 'data-rubrique': '' },
    champ,
    h('span', { class: 'font-mono text-xs text-ink-400', 'data-adresse': '' }, slug ? `/${slug}/` : ''),
    h('span', { class: 'flex-1' }),
    state.rubriques.length > 1
      ? h(
          'button',
          {
            type: 'button',
            class: 'icon-btn',
            'aria-label': t('action.delete'),
            onclick: () => {
              state.rubriques.splice(index, 1);
              categoryAction.onChange?.();
            },
          },
          icon('trash'),
        )
      : null,
  );
}

function formulaireSimple() {
  return h(
    'div',
    { class: 'mt-4 space-y-2.5' },
    state.rubriques.map((_, i) => champRubrique(i)),
    state.rubriques.length < MAX_RUBRIQUES
      ? h(
          'button',
          {
            type: 'button',
            class: 'btn btn-ghost px-2 py-1 text-xs',
            onclick: () => {
              state.rubriques.push('');
              categoryAction.onChange?.();
            },
          },
          icon('plus', 'size-3.5'),
          t('categories.add_row'),
        )
      : null,
  );
}

/** Glisser-déposer ou parcourir : le fichier est lu dans le navigateur, jamais envoyé. */
function zoneFichier() {
  const choisir = h('input', {
    type: 'file',
    accept: '.csv,text/csv,text/plain',
    class: 'hidden',
    onchange: (e) => lireFichier(e.target.files?.[0]),
  });

  const zone = h(
    'div',
    {
      class:
        'flex flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-ink-200 bg-ink-50/40 px-4 py-6 text-center transition',
      ondragover: (e) => {
        e.preventDefault();
        zone.classList.add('border-accent', 'bg-accent-50');
      },
      ondragleave: () => zone.classList.remove('border-accent', 'bg-accent-50'),
      ondrop: (e) => {
        e.preventDefault();
        zone.classList.remove('border-accent', 'bg-accent-50');
        lireFichier(e.dataTransfer?.files?.[0]);
      },
    },
    icon('upload', 'size-6 text-ink-300'),
    h('p', { class: 'text-sm font-medium text-ink-600' }, t('categories.drop_title')),
    h(
      'button',
      { type: 'button', class: 'btn btn-outline mt-1 px-3 py-1.5 text-xs', onclick: () => choisir.click() },
      t('categories.drop_browse'),
    ),
    h('p', { class: 'text-xs text-ink-400' }, t('categories.drop_hint')),
    choisir,
  );
  return zone;
}

function lireFichier(fichier) {
  if (!fichier) return;
  if (fichier.size > 2 * 1024 * 1024) return toast(t('categories.file_too_big'), 'error');
  const lecteur = new FileReader();
  lecteur.onload = () => {
    const texte = parseCsv(String(lecteur.result ?? ''));
    state.texte = texte;
    if (zoneTable) zoneTable.value = texte;
    state.parse = parseTable(texte);
    toast(t('categories.file_read', { name: fichier.name, sites: fmtNum(state.parse.lignes.length) }), 'success');
    planifierResolution();
    categoryAction.onChange?.();
  };
  lecteur.onerror = () => toast(t('categories.file_failed'), 'error');
  lecteur.readAsText(fichier, 'utf-8');
}

function formulaireTable() {
  zoneTable ??= h('textarea', {
    class: 'input font-mono text-xs leading-5',
    rows: '6',
    spellcheck: 'false',
    placeholder: 'exemple.com, Sport, Cuisine\nautre-site.fr, Voyages',
    oninput: (e) => {
      state.texte = e.target.value;
      state.parse = parseTable(e.target.value);
      planifierResolution();
    },
  });

  const p = state.parse;
  return h(
    'div',
    { class: 'mt-4 space-y-2' },
    h('p', { class: 'text-sm text-ink-500' }, t('categories.table_hint')),
    zoneFichier(),
    zoneTable,
    p
      ? h(
          'div',
          { class: 'space-y-1' },
          h(
            'p',
            { class: 'text-sm text-ink-700' },
            t('categories.table_read', { sites: fmtNum(p.lignes.length), cats: fmtNum(p.lignes.reduce((n, l) => n + l.noms.length, 0)) }),
          ),
          p.inconnus.length
            ? h('p', { class: 'text-sm text-amber-700' }, t('categories.table_skipped', { lines: p.inconnus.slice(0, 5).join(', ') }))
            : null,
          state.resolving ? h('p', { class: 'text-xs text-ink-400' }, t('actions.resolving')) : null,
          state.cibles?.unknown?.length
            ? h('p', { class: 'text-sm text-red-600' }, t('actions.unknown', { count: fmtNum(state.cibles.unknown.length) }), ' ', state.cibles.unknown.slice(0, 6).join(', '))
            : null,
        )
      : null,
  );
}

let minuteur = null;
function planifierResolution() {
  clearTimeout(minuteur);
  minuteur = setTimeout(resoudre, 400);
}

/** Où vivent les domaines collés ? Le back-office les cherche sur tout le parc. */
async function resoudre() {
  const domaines = (state.parse?.lignes ?? []).map((l) => l.domain);
  if (!domaines.length) {
    state.cibles = null;
    return categoryAction.onChange?.();
  }
  state.resolving = true;
  categoryAction.onChange?.();
  try {
    state.cibles = await api('/api/domains/resolve', { method: 'POST', body: { domains: domaines } });
  } catch (err) {
    state.cibles = null;
    toastError(err);
  } finally {
    state.resolving = false;
    categoryAction.onChange?.();
  }
}

// ───────────────────────── Création ─────────────────────────

async function creer(sites, bouton, etiquette) {
  const parServeur = new Map();
  for (const site of sites) {
    if (!parServeur.has(site.server)) parServeur.set(site.server, []);
    parServeur.get(site.server).push(site);
  }

  bouton.disabled = true;
  let creees = 0;
  let echecs = 0;
  try {
    let faits = 0;
    for (const [server, liste] of parServeur) {
      for (let i = 0; i < liste.length; i += 40) {
        const lot = liste.slice(i, i + 40);
        const request = {};
        for (const site of lot) request[site.domain] = site.items.map((it) => ({ name: it.name, slug: it.slug }));
        const out = await api(`/api/servers/${enc(server)}/categories/apply`, { method: 'POST', body: { request, operation: state.operation } });
        for (const res of out.sites ?? []) {
          const site = lot.find((s) => s.domain === res.domain);
          if (!site) continue;
          site.items = res.items;
          site.configError = res.configError ?? null;
          const faites = res.items.filter((it) => it.done.length).length;
          creees += faites;
          echecs += res.items.filter((it) => it.failed.length).length;
          if (faites) state.done.set(keyOf(site), faites);
        }
        faits += lot.length;
        if (etiquette) etiquette.textContent = t('categories.working', { done: fmtNum(faits), total: fmtNum(sites.length) });
        categoryAction.onChange?.();
      }
    }
    toast(t('categories.created', { count: fmtNum(creees), sites: fmtNum(state.done.size) }), echecs ? 'info' : 'success');
    if (echecs) toast(t('categories.failed', { count: fmtNum(echecs) }), 'error');
  } catch (err) {
    toastError(err);
  } finally {
    bouton.disabled = false;
    categoryAction.onChange?.();
  }
}

function creerTout() {
  const todo = (state.plan?.sites ?? []).filter((s) => !s.error && !state.done.has(keyOf(s)) && s.items.some((it) => aFaire(it)));
  if (!todo.length) return toast(t('categories.nothing_to_do'), 'info');
  confirmer(todo);
}

/**
 * La fenêtre de confirmation. Elle annonce des nombres, jamais « êtes-vous sûr ? » :
 * combien de sites, combien de rubriques, et combien d'articles seront conservés.
 */
function confirmer(sites) {
  const suppr = state.operation === 'remove';
  const total = sites.reduce((n, s) => n + s.items.filter((it) => aFaire(it)).length, 0);
  if (!total) return toast(t('categories.nothing_to_do'), 'info');
  const articles = suppr ? sites.reduce((n, s) => n + s.items.filter((it) => aFaire(it)).reduce((m, it) => m + (it.articles ?? 0), 0), 0) : 0;

  const go = h(
    'button',
    { type: 'button', class: suppr ? 'btn btn-danger' : 'btn btn-primary' },
    icon(suppr ? 'trash' : 'folderPlus'),
    h('span', {}, t(suppr ? 'categories.remove_go' : 'categories.create_go')),
  );
  go.addEventListener('click', async () => {
    await creer(sites, go, go.lastChild);
    closeModal();
  });

  openModal(
    h(
      'div',
      {},
      modalHeader(
        t(suppr ? 'categories.remove_title' : 'categories.create_title'),
        suppr ? 'bg-red-50 text-red-600' : 'bg-accent-50 text-accent-700',
        suppr ? 'trash' : 'folderPlus',
      ),
      h('p', { class: 'text-sm text-ink-600' }, t(suppr ? 'categories.remove_body' : 'categories.create_body', { sites: fmtNum(sites.length), cats: fmtNum(total) })),
      articles ? h('p', { class: 'mt-2 text-sm font-medium text-ink-700' }, t('categories.remove_articles', { count: fmtNum(articles) })) : null,
      h('p', { class: 'mt-2 text-sm text-ink-500' }, t(suppr ? 'categories.remove_note' : 'categories.safety_note')),
      h('div', { class: 'mt-6 flex justify-end gap-2' }, h('button', { type: 'button', class: 'btn btn-ghost', onclick: closeModal }, t('action.cancel')), go),
    ),
  );
}

// ───────────────────────── Résultat de la vérification ─────────────────────────

/**
 * Ce qu'il reste à faire sur une rubrique, selon le verbe : à l'ajout, ce qui manque ;
 * à la suppression, ce qui est encore là.
 */
const aFaire = (it) => (state.operation === 'remove' ? it.dir || it.config || it.json : !it.dir || !it.config);

const etatBadge = (present) => {
  const attendu = state.operation === 'remove' ? !present : present;
  if (attendu) return h('span', { class: 'badge bg-accent-50 text-accent-700' }, icon('check', 'size-3.5'), t(state.operation === 'remove' ? 'categories.state_gone' : 'categories.state_present'));
  return h(
    'span',
    { class: state.operation === 'remove' ? 'badge bg-red-50 text-red-700' : 'badge bg-amber-50 text-amber-700' },
    icon(state.operation === 'remove' ? 'trash' : 'plus', 'size-3.5'),
    t(state.operation === 'remove' ? 'categories.state_remove' : 'categories.state_todo'),
  );
};

function listeSites() {
  const sites = state.plan?.sites ?? [];
  const rows = sites.map((site) => {
    const actif = state.selected === keyOf(site);
    const reste = site.items.filter((it) => aFaire(it)).length;
    return h(
      'button',
      {
        type: 'button',
        class: `flex w-full items-center gap-3 border-b border-ink-100 px-4 py-3 text-left transition last:border-0 ${actif ? 'bg-accent-50' : 'hover:bg-ink-50'}`,
        'aria-current': String(actif),
        onclick: () => {
          state.selected = keyOf(site);
          categoryAction.onChange?.();
        },
      },
      h(
        'span',
        { class: 'min-w-0 flex-1' },
        h('span', { class: 'block truncate text-sm font-medium' }, site.domain),
        h('span', { class: 'mt-0.5 block truncate text-xs text-ink-400' }, site.serverLabel),
      ),
      site.error
        ? h('span', { class: 'badge bg-red-50 text-red-600' }, t(`categories.error_${site.error}`))
        : reste
          ? h('span', { class: 'badge bg-amber-50 text-amber-700 tabular-nums' }, fmtNum(reste))
          : h('span', { class: 'badge bg-accent-100 text-accent-700' }, icon('check', 'size-3.5')),
    );
  });

  return h(
    'div',
    { class: 'card overflow-hidden self-start' },
    h('p', { class: 'border-b border-ink-100 bg-ink-50/60 px-4 py-2.5 text-xs font-semibold tracking-wide text-ink-500 uppercase' }, t('categories.sites')),
    h('div', { class: 'max-h-[32rem] overflow-y-auto' }, rows),
  );
}

function detailSite(permissions) {
  const site = (state.plan?.sites ?? []).find((s) => keyOf(s) === state.selected);
  if (!site) return h('div', { class: 'card px-6 py-16 text-center text-ink-400' }, t('categories.pick_site'));
  if (site.error) {
    return h(
      'div',
      { class: 'card px-6 py-16 text-center' },
      h('p', { class: 'font-semibold' }, site.domain),
      h('p', { class: 'mt-2 text-sm text-red-600' }, t(`categories.error_${site.error}_long`)),
    );
  }

  const rows = site.items.map((it) =>
    h(
      'div',
      { class: 'grid gap-2 px-5 py-3 sm:grid-cols-[1fr_auto] sm:items-center' },
      h(
        'div',
        { class: 'min-w-0' },
        h('p', { class: 'text-sm font-medium' }, it.name),
        h(
          'p',
          { class: 'flex flex-wrap items-center gap-2 font-mono text-[11px] text-ink-400' },
          `/${it.slug}/`,
          // Ce que l'agent doit savoir avant de supprimer : la rubrique porte des
          // articles, et ils resteront en place.
          state.operation === 'remove' && it.articles
            ? h('span', { class: 'badge bg-ink-100 font-sans text-ink-600' }, t('categories.keeps_articles', { count: fmtNum(it.articles) }))
            : null,
        ),
      ),
      h(
        'div',
        { class: 'flex flex-wrap items-center gap-2' },
        h('span', { class: 'text-xs text-ink-400' }, t('categories.piece_page')),
        etatBadge(it.dir),
        h('span', { class: 'text-xs text-ink-400' }, t('categories.piece_menu')),
        etatBadge(it.config),
        site.summary ? h('span', { class: 'text-xs text-ink-400' }, t('categories.piece_summary')) : null,
        site.summary ? etatBadge(it.json) : null,
      ),
    ),
  );

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
          h('span', { class: 'badge bg-ink-50 text-ink-500' }, site.serverLabel),
          state.done.has(keyOf(site)) ? h('span', { class: 'badge bg-accent-100 text-accent-700' }, icon('check', 'size-3.5'), t('categories.done_badge')) : null,
        ),
        site.configError ? h('p', { class: 'mt-1 text-xs text-red-600' }, t('categories.config_failed')) : null,
        !site.summary ? h('p', { class: 'mt-1 text-xs text-ink-400' }, t('categories.no_summary')) : null,
      ),
      h(
        'button',
        {
          type: 'button',
          class: state.operation === 'remove' ? 'btn btn-danger' : 'btn btn-primary',
          disabled: !permissions.includes('design.publish'),
          title: permissions.includes('design.publish') ? null : t('reason.permission_denied'),
          onclick: (e) => (state.operation === 'remove' ? confirmer([site], e.currentTarget) : creer([site], e.currentTarget)),
        },
        icon(state.operation === 'remove' ? 'trash' : 'folderPlus'),
        t(state.operation === 'remove' ? 'categories.remove_site' : 'categories.create_site'),
      ),
    ),
    h('div', { class: 'divide-y divide-ink-100' }, rows),
    h('p', { class: 'border-t border-ink-100 bg-ink-50/60 px-5 py-3 text-xs text-ink-500' }, t('categories.safety_note')),
  );
}

function barre(permissions) {
  const sites = (state.plan?.sites ?? []).filter((s) => !s.error);
  const reste = sites.filter((s) => s.items.some((it) => aFaire(it)));
  const total = reste.reduce((n, s) => n + s.items.filter((it) => aFaire(it)).length, 0);
  return h(
    'div',
    { class: 'card flex flex-wrap items-center gap-3 px-5 py-3' },
    h('p', { class: 'min-w-0 flex-1 text-sm text-ink-500' }, t(state.operation === 'remove' ? 'categories.bulk_hint_remove' : 'categories.bulk_hint', { sites: fmtNum(reste.length), cats: fmtNum(total) })),
    h(
      'button',
      {
        type: 'button',
        class: state.operation === 'remove' ? 'btn btn-danger' : 'btn btn-primary',
        disabled: !reste.length || !permissions.includes('design.publish'),
        title: permissions.includes('design.publish') ? null : t('reason.permission_denied'),
        onclick: creerTout,
      },
      icon(state.operation === 'remove' ? 'trash' : 'folderPlus'),
      h('span', {}, t(state.operation === 'remove' ? 'categories.remove_all' : 'categories.create_all', { count: fmtNum(reste.length) })),
    ),
  );
}

// ───────────────────────── L'action, telle que l'écran la voit ─────────────────────────

export const categoryAction = {
  key: 'categories',
  icon: 'folderPlus',
  labelKey: 'actions.categories',
  // Le verbe choisi décide du reste : c'est la même action, pas deux entrées de menu.
  hintKey: 'categories.explain',
  startLabelKey: 'categories.verify',
  batch: 60,
  onChange: null,

  reset() {
    state.plan = null;
    state.selected = null;
    state.done.clear();
  },

  /** Étape 1 : ce que l'agent saisit, avant même de choisir les sites. */
  get beforeRunKey() {
    return state.operation === 'remove' ? 'categories.before_run_remove' : 'categories.before_run';
  },

  form({ step = 1 } = {}) {
    const verbe = (cle, ico, libelle) => {
      const actif = state.operation === cle;
      const couleur = cle === 'remove' ? 'border-red-300 bg-red-50 text-red-700' : 'border-accent bg-accent-50 text-ink';
      return h(
        'button',
        {
          type: 'button',
          class: `flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium transition ${actif ? couleur : 'border-ink-200 bg-white text-ink-400 hover:border-ink-300'}`,
          'aria-pressed': String(actif),
          onclick: () => {
            if (state.operation === cle) return;
            state.operation = cle;
            // Changer de verbe invalide la vérification précédente : elle ne parlait
            // pas de la même chose.
            categoryAction.reset();
            categoryAction.onChange?.();
          },
        },
        icon(ico, 'size-3.5'),
        libelle,
      );
    };

    const onglet = (cle, libelle) =>
      h(
        'button',
        {
          type: 'button',
          class: 'seg',
          'aria-pressed': String(state.mode === cle),
          onclick: () => {
            state.mode = cle;
            categoryAction.onChange?.();
          },
        },
        libelle,
      );

    return h(
      'div',
      { class: 'card p-5' },
      h(
        'div',
        { class: 'flex flex-wrap items-center gap-3' },
        h('div', { class: 'min-w-0 flex-1' }, stepTitle(step, t(state.operation === 'remove' ? 'categories.step_remove' : 'categories.step_what'))),
        h('div', { class: 'flex rounded-lg bg-ink-50 p-1' }, onglet('simple', t('categories.mode_simple')), onglet('table', t('categories.mode_table'))),
      ),
      // Deux verbes, deux couleurs : on ne supprime pas par mégarde.
      h(
        'div',
        { class: 'mt-3 flex flex-wrap items-center gap-2' },
        verbe('add', 'plus', t('categories.op_add')),
        verbe('remove', 'trash', t('categories.op_remove')),
        h('p', { class: 'text-xs text-ink-400' }, t(state.operation === 'remove' ? 'categories.op_remove_hint' : 'categories.op_add_hint')),
      ),
      state.mode === 'simple' ? formulaireSimple() : formulaireTable(),
    );
  },

  /** En mode tableau, les sites viennent du tableau : le périmètre de l'écran s'efface. */
  targets() {
    if (state.mode !== 'table') return null;
    return state.cibles?.found ?? [];
  },

  /** Rien à vérifier tant qu'aucune rubrique n'est saisie. */
  canRun() {
    return state.mode === 'table' ? Boolean(state.parse?.lignes.length) : nomsSaisis().length > 0;
  },

  async run(server, domains) {
    const cibles = domains.map((domain) => ({ domain, server }));
    const request = demande(cibles);
    if (!Object.keys(request).length) return;
    const out = await api(`/api/servers/${enc(server)}/categories/plan`, { method: 'POST', body: { request, operation: state.operation } });
    state.plan ??= { sites: [] };
    for (const site of out.sites ?? []) state.plan.sites.push({ ...site, server, serverLabel: server });
    if (!state.selected && state.plan.sites.length) state.selected = keyOf(state.plan.sites[0]);
  },

  stats() {
    const sites = (state.plan?.sites ?? []).filter((s) => !s.error);
    const aCreer = sites.reduce((n, s) => n + s.items.filter((it) => aFaire(it)).length, 0);
    const deja = sites.reduce((n, s) => n + s.items.filter((it) => !aFaire(it)).length, 0);
    const faites = [...state.done.values()].reduce((a, b) => a + b, 0);
    const erreurs = (state.plan?.sites ?? []).filter((s) => s.error).length;
    const cells = [
      ['categories.stat_sites', fmtNum(sites.length), 'text-ink'],
      ['categories.stat_todo', fmtNum(aCreer), 'text-amber-700'],
      ['categories.stat_present', fmtNum(deja), 'text-ink-300'],
      ['categories.stat_created', fmtNum(faites), 'text-accent-700'],
    ];
    if (erreurs) cells.push(['categories.stat_errors', fmtNum(erreurs), 'text-red-600']);
    return cells;
  },

  ready: () => Boolean(state.plan?.sites.length),

  results({ permissions = [] } = {}) {
    if (!state.plan?.sites.length) return null;
    return h(
      'div',
      { class: 'space-y-4' },
      barre(permissions),
      h('div', { class: 'grid gap-4 lg:grid-cols-[19rem_1fr]' }, listeSites(), detailSite(permissions)),
    );
  },

  emptyState: () =>
    h(
      'div',
      { class: 'card px-6 py-16 text-center' },
      h('span', { class: 'mx-auto flex size-12 items-center justify-center rounded-2xl bg-accent-50 text-accent-700' }, icon('check', 'size-6')),
      h('p', { class: 'mt-4 font-semibold' }, t('categories.all_done')),
      h('p', { class: 'mt-1 text-sm text-ink-500' }, t('categories.all_done_hint')),
    ),

  finished() {
    const sites = (state.plan?.sites ?? []).filter((s) => !s.error);
    const aCreer = sites.reduce((n, s) => n + s.items.filter((it) => aFaire(it)).length, 0);
    toast(t('categories.checked', { sites: fmtNum(sites.length), cats: fmtNum(aCreer) }), 'success');
  },

  labelServers(labelFor) {
    for (const site of state.plan?.sites ?? []) site.serverLabel = labelFor(site.server);
  },
};

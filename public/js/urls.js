import { t } from './i18n.js';
import { fmtNum, fmtSize, h, icon } from './ui.js';

/**
 * Action « Scanner 404 ».
 *
 * L'agent arrive avec une liste d'adresses — celles que la Search Console lui signale —
 * et veut savoir lesquelles sont mortes, sur quels sites, puis les rediriger. L'écran
 * suit donc cet ordre, et rien d'autre :
 *
 *   1. LES ADRESSES à tester, collées telles qu'il les a.
 *   2. LES SITES, par le sélecteur habituel de l'écran (c'est lui, la multi-sélection).
 *   3. LE RÉSULTAT, groupé par état, avec un raccourci vers la redirection 301.
 *
 * DEUX ÉTATS DEMANDENT UN GESTE, et il faut les distinguer :
 *
 *   - « adresse morte » : le serveur répond 404, tout le monde le voit ;
 *   - « page absente, serveur muet » : le serveur répond 200 en servant la page
 *     d'accueil. Mesuré sur onze sites de deux serveurs, toute adresse SANS EXTENSION se
 *     comporte ainsi. C'est le pire cas, parce que rien ne le signale : ni le visiteur,
 *     ni Google, ni les journaux. Le scan le démasque en comparant le titre de la page
 *     servie à celui de l'accueil.
 *
 * ET UNE LIMITE EST DITE PLUTÔT QUE CACHÉE : le mécanisme de redirection ne sait poser un
 * 301 que sur une adresse en « .php ». Les faux 404 sans extension sont donc trouvés, mais
 * pas réparables ici — cela demande une règle nginx, donc l'administrateur. Le bouton le
 * dit au lieu d'échouer en silence.
 */

const MAX_LIGNES = 50;

const ORDRE = ['missing', 'soft_missing', 'server_error', 'php_error', 'unreachable', 'no_answer', 'refused', 'redirect', 'ok'];

/** Ce que le raccourci 301 peut reprendre : une adresse morte, d'une façon ou d'une autre. */
const A_REDIRIGER = ['missing', 'soft_missing'];

/**
 * La couleur dit la gravité. Classes écrites en entier : Tailwind lit ce fichier pour
 * produire sa feuille et ne verrait pas une classe assemblée à l'exécution.
 */
const TEINTES = {
  missing: 'bg-red-100 text-red-700',
  soft_missing: 'bg-red-100 text-red-700',
  server_error: 'bg-red-100 text-red-700',
  php_error: 'bg-red-100 text-red-700',
  unreachable: 'bg-red-100 text-red-700',
  no_answer: 'bg-red-100 text-red-700',
  refused: 'bg-amber-100 text-amber-800',
  redirect: 'bg-ink-100 text-ink-500',
  ok: 'bg-accent-50 text-accent-700',
};

const state = {
  // Ce que l'agent a collé, gardé tel quel : il doit pouvoir se relire et corriger.
  texte: '',
  urls: [],
  charge: null,
  // Les adresses retenues pour la redirection, par chemin : une redirection se pose à
  // l'identique sur tous les sites concernés, c'est donc le chemin qui se choisit.
  choisis: new Set(),
};

/** Ce que l'agent a collé, ramené à des chemins — même règle que côté serveur. */
export function cheminsSaisis(brut = state.texte) {
  const vus = new Set();
  const chemins = [];
  const refuses = [];
  for (const ligne of String(brut ?? '').split(/[\r\n,;]+/)) {
    const t = ligne.trim();
    if (!t) continue;
    let chemin = t;
    const complet = /^https?:\/\/[^/]+(\/.*)?$/i.exec(t);
    if (complet) chemin = complet[1] ?? '/';
    else if (!chemin.startsWith('/')) chemin = `/${chemin}`;
    chemin = chemin.replace(/#.*$/, '');
    // eslint-disable-next-line no-control-regex
    if (chemin.length > 1024 || /[\u0000- \u007f"'\\]/.test(chemin)) {
      refuses.push(t.slice(0, 120));
      continue;
    }
    if (vus.has(chemin) || chemins.length >= MAX_LIGNES) continue;
    vus.add(chemin);
    chemins.push(chemin);
  }
  return { paths: chemins, rejected: refuses };
}

const parEtat = () => {
  const par = {};
  for (const u of state.urls) (par[u.state] ??= []).push(u);
  return par;
};

const mortes = () => state.urls.filter((u) => A_REDIRIGER.includes(u.state));

/** Les chemins morts, sans doublon : c'est l'unité que la redirection sait traiter. */
const cheminsMorts = () => [...new Set(mortes().map((u) => u.path))];

export const urlAction = {
  key: 'urls',
  icon: 'search',
  labelKey: 'actions.urls',
  hintKey: 'urls.explain',
  // Vingt domaines par lot : le lot se multiplie par le nombre d'adresses, et le frein du
  // serveur se compte en domaines.
  batch: 20,
  onChange: null,

  reset() {
    state.urls = [];
    state.charge = null;
    state.choisis.clear();
  },

  form({ step = 1 } = {}) {
    const { paths, rejected } = cheminsSaisis();
    return h(
      'div',
      { class: 'card p-5' },
      etape(step, t('urls.step_what'), t('urls.step_what_hint')),
      zoneSaisie(),
      h(
        'div',
        { class: 'mt-2 space-y-1' },
        paths.length
          ? h('p', { class: 'text-sm text-accent-700' }, t('urls.kept', { count: fmtNum(paths.length) }))
          : h('p', { class: 'text-sm text-ink-400' }, t('urls.paste_hint')),
        rejected.length
          ? h(
              'p',
              { class: 'text-sm text-red-600' },
              t('urls.rejected', { count: fmtNum(rejected.length) }),
              ' ',
              h('span', { class: 'font-mono text-xs' }, rejected.slice(0, 3).join(' · ')),
            )
          : null,
      ),
    );
  },

  /** Sans adresse, rien à chercher : le bouton reste gris plutôt que de lancer dans le vide. */
  canRun: () => cheminsSaisis().paths.length > 0,

  jobKind: 'urls.scan',
  jobParams: () => ({ paths: cheminsSaisis().paths }),

  absorb(server, out) {
    for (const u of out?.urls ?? []) state.urls.push({ ...u, server });
    if (out?.load && (!state.charge || out.load.io > state.charge.io)) state.charge = { ...out.load, server };
  },

  stats() {
    // LE MINI-TABLEAU DE BORD. Quatre chiffres, et celui qui compte est le deuxième :
    // combien d'adresses sont mortes. « Sur combien de sites » est à côté parce que
    // douze adresses mortes sur un site et sur douze ne se traitent pas pareil.
    const m = mortes().length;
    return [
      ['urls.stat_checked', fmtNum(state.urls.length), 'text-ink'],
      ['urls.stat_dead', fmtNum(m), m ? 'text-red-600' : 'text-ink-300'],
      ['urls.stat_alive', fmtNum((parEtat().ok ?? []).length), 'text-accent-700'],
      ['urls.stat_sites', fmtNum(new Set(state.urls.map((u) => u.domain)).size), 'text-ink-500'],
    ];
  },

  ready: () => state.urls.length > 0,

  emptyState: () => h('p', { class: 'card px-4 py-6 text-center text-sm text-ink-500' }, t('urls.nothing_measured')),

  results({ handover = null } = {}) {
    if (!state.urls.length) return null;
    const par = parEtat();
    return h(
      'div',
      { class: 'space-y-4' },
      noteCharge(),
      mortes().length ? barreRedirection(handover) : rienDeMort(),
      ...ORDRE.filter((etat) => par[etat]?.length).map((etat) => groupe(etat, par[etat])),
    );
  },
};

/** Le titre d'étape, repris de l'écran pour ne pas dépendre de son gabarit interne. */
function etape(numero, titre, aide) {
  return h(
    'div',
    { class: 'mb-3' },
    h(
      'p',
      { class: 'flex items-center gap-2 text-sm font-semibold text-ink' },
      h('span', { class: 'flex size-5 items-center justify-center rounded-full bg-accent-50 text-xs text-accent-700' }, String(numero)),
      titre,
    ),
    aide ? h('p', { class: 'mt-1 ml-7 text-sm text-ink-500' }, aide) : null,
  );
}

/**
 * La zone de saisie, délibérément en police à chasse fixe.
 *
 * Ce sont des adresses : une barre oblique de travers ou un tiret manquant se voient dans
 * une colonne alignée, et pas autrement. Le champ n'est pas recréé d'un rendu à l'autre —
 * son contenu vit dans `state.texte` — sinon le curseur sauterait à chaque frappe.
 */
let zone = null;
function zoneSaisie() {
  zone ??= h('textarea', {
    class: 'input h-36 w-full resize-y font-mono text-xs',
    spellcheck: 'false',
    placeholder: '/une-ancienne-page.php\nhttps://exemple.fr/une-autre.php',
    oninput: (e) => {
      state.texte = e.target.value;
      urlAction.onChange?.();
    },
  });
  zone.value = state.texte;
  return zone;
}

/** Quand la machine souffrait, le dire — une fois, et seulement si c'est vrai. */
function noteCharge() {
  if (!state.charge || (state.charge.io <= 50 && state.charge.parCoeur <= 2)) return null;
  return h(
    'p',
    { class: 'flex items-start gap-2 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900' },
    icon('alert', 'size-4 shrink-0 mt-0.5'),
    t('urls.busy_note', { server: state.charge.server, io: String(Math.round(state.charge.io)) }),
  );
}

function rienDeMort() {
  return h(
    'p',
    { class: 'flex items-center gap-2 rounded-lg bg-accent-50 px-4 py-3 text-sm font-medium text-accent-700' },
    icon('check'),
    t('urls.none_dead'),
  );
}

/**
 * LE RACCOURCI 301. Il ne pose rien lui-même : il remplit l'écran des redirections avec
 * les adresses mortes et les sites concernés, puis laisse l'agent choisir les destinations.
 * C'est lui qui sait où envoyer le visiteur ; nous, non.
 */
function barreRedirection(handover) {
  const chemins = cheminsMorts();
  const retenus = chemins.filter((c) => state.choisis.has(c));
  const effectifs = retenus.length ? retenus : chemins;
  // Une adresse sans extension ne peut pas recevoir de fichier-relais : nginx servirait
  // le fichier en clair. Le mécanisme de redirection le refuserait ; mieux vaut le dire ici.
  const redirigeables = effectifs.filter((c) => c.endsWith('.php'));
  const hors = effectifs.length - redirigeables.length;
  const sites = [...new Set(mortes().filter((u) => effectifs.includes(u.path)).map((u) => u.domain))];

  return h(
    'div',
    { class: 'card flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3' },
    h(
      'p',
      { class: 'flex-1 text-sm text-ink-500' },
      h('span', { class: 'font-semibold text-ink' }, t('urls.dead_count', { count: fmtNum(effectifs.length), sites: fmtNum(sites.length) })),
      hors ? h('span', { class: 'mt-0.5 block text-xs text-amber-700' }, t('urls.not_redirectable', { count: fmtNum(hors) })) : null,
    ),
    handover
      ? h(
          'button',
          {
            type: 'button',
            class: 'btn-primary',
            disabled: !redirigeables.length,
            title: redirigeables.length ? null : t('urls.not_redirectable_hint'),
            onclick: () => handover({ paths: redirigeables, domains: sites }),
          },
          h('span', { class: 'inline-flex items-center gap-2' }, icon('link'), t('urls.to_redirect')),
        )
      : null,
  );
}

/** Un état, son nombre, et les adresses concernées. */
function groupe(etat, urls) {
  const multi = new Set(state.urls.map((u) => u.server)).size > 1;
  const choisissable = A_REDIRIGER.includes(etat);
  return h(
    'section',
    { class: 'card overflow-hidden' },
    h(
      'header',
      { class: 'flex items-center gap-2 border-b border-ink-100 px-4 py-2.5' },
      h('span', { class: `rounded-md px-2 py-0.5 text-xs font-semibold ${TEINTES[etat] ?? 'bg-ink-100 text-ink-500'}` }, t(`urls.state_${etat}`)),
      h('span', { class: 'text-sm font-medium text-ink' }, fmtNum(urls.length)),
      h('span', { class: 'flex-1' }),
      etat === 'soft_missing' ? h('span', { class: 'text-xs text-ink-400' }, t('urls.soft_missing_hint')) : null,
    ),
    h(
      'div',
      { class: 'max-h-80 overflow-y-auto' },
      h(
        'table',
        { class: 'w-full text-sm' },
        h(
          'thead',
          { class: 'sticky top-0 bg-white text-xs text-ink-400' },
          h(
            'tr',
            {},
            choisissable ? h('th', { class: 'w-9 px-3 py-2' }) : null,
            h('th', { class: 'px-4 py-2 text-left font-medium' }, t('urls.col_path')),
            h('th', { class: 'px-3 py-2 text-left font-medium' }, t('col.domain')),
            multi ? h('th', { class: 'px-3 py-2 text-left font-medium' }, t('col.server')) : null,
            h('th', { class: 'px-3 py-2 text-right font-medium' }, t('urls.col_code')),
            h('th', { class: 'px-4 py-2 text-right font-medium' }, t('urls.col_size')),
          ),
        ),
        h(
          'tbody',
          {},
          urls.map((u) =>
            h(
              'tr',
              { class: 'border-t border-ink-50' },
              choisissable
                ? h(
                    'td',
                    { class: 'px-3 py-1.5' },
                    h('input', {
                      type: 'checkbox',
                      class: 'size-4 rounded border-ink-200 text-accent-600',
                      checked: state.choisis.has(u.path),
                      'aria-label': u.path,
                      onchange: (e) => {
                        if (e.target.checked) state.choisis.add(u.path);
                        else state.choisis.delete(u.path);
                        urlAction.onChange?.();
                      },
                    }),
                  )
                : null,
              h('td', { class: 'max-w-[22rem] truncate px-4 py-1.5 font-mono text-xs text-ink', title: u.path }, u.path),
              h(
                'td',
                { class: 'px-3 py-1.5' },
                h(
                  'a',
                  { href: `https://${u.domain}${u.path}`, target: '_blank', rel: 'noopener', class: 'text-accent-700 hover:underline' },
                  u.domain,
                ),
              ),
              multi ? h('td', { class: 'px-3 py-1.5 text-ink-400' }, u.server) : null,
              h('td', { class: 'px-3 py-1.5 text-right tabular-nums text-ink-500' }, u.code || '—'),
              h('td', { class: 'px-4 py-1.5 text-right tabular-nums text-ink-500' }, u.bytes ? fmtSize(u.bytes) : '—'),
            ),
          ),
        ),
      ),
    ),
    // La destination d'un renvoi explique l'état mieux qu'un code : elle est donnée en pied.
    etat === 'redirect'
      ? h(
          'ul',
          { class: 'border-t border-ink-100 bg-ink-50 px-4 py-2 font-mono text-xs text-ink-500' },
          urls.slice(0, 20).map((u) => h('li', { class: 'truncate' }, `${u.path} → ${u.redirect ?? '—'}`)),
        )
      : null,
  );
}

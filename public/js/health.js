import { t } from './i18n.js';
import { fmtDate, fmtNum, fmtSize, h, icon } from './ui.js';

/**
 * Action « Santé du parc ».
 *
 * ELLE NE DEMANDE RIEN À L'AGENT, et c'est volontaire : il choisit son périmètre comme
 * pour les autres traitements, lance, et lit. Aucun réglage de seuil, aucun nombre de
 * sondes à décider — ces choix sont mesurés, non devinés, et vivent dans
 * `src/services/healthService.js` avec les mesures qui les justifient.
 *
 * CE QUE L'ÉCRAN DOIT FAIRE COMPRENDRE EN TROIS SECONDES : combien de sites vont bien,
 * lesquels ne vont pas, et pourquoi. Les sites sains sont donc masqués par défaut dès
 * qu'il y a un problème à montrer — une liste de 5 000 lignes vertes cache les dix
 * rouges qui comptent.
 *
 * Rien n'est écrit sur les serveurs : la sonde demande une page d'accueil, comme un
 * visiteur. C'est pourquoi le droit exigé est celui d'analyse, et non celui d'écriture.
 */

/** Les états rangés du plus grave au plus bénin : c'est l'ordre d'affichage. */
const ORDRE = [
  'unreachable',
  'no_answer',
  'server_error',
  'php_error',
  'empty',
  'missing',
  'refused',
  'slow',
  'redirect',
  'invalid',
  'ok',
];

/**
 * La couleur dit la gravité, le libellé dit la cause.
 *
 * Classes écrites en entier : Tailwind lit ce fichier pour produire sa feuille et ne
 * verrait pas une classe assemblée à l'exécution.
 */
const TEINTES = {
  ok: 'bg-accent-50 text-accent-700',
  slow: 'bg-amber-100 text-amber-800',
  redirect: 'bg-ink-100 text-ink-500',
  invalid: 'bg-ink-100 text-ink-500',
  empty: 'bg-amber-100 text-amber-800',
  missing: 'bg-amber-100 text-amber-800',
  refused: 'bg-amber-100 text-amber-800',
  php_error: 'bg-red-100 text-red-700',
  server_error: 'bg-red-100 text-red-700',
  unreachable: 'bg-red-100 text-red-700',
  no_answer: 'bg-red-100 text-red-700',
};

const state = {
  sites: [],
  // LA MACHINE LA PLUS CHARGÉE rencontrée, et non la dernière : c'est elle qui explique
  // qu'un site y paraisse lent. Garder la dernière donnait 14,2 pour vps-002 alors que
  // vps-001, à 22,9, était le seul à peiner — l'agent lisait le chiffre rassurant.
  charge: null,
  // Masquer les sites sains : décidé à l'affichage, pas ici, pour que l'agent puisse
  // revenir à la liste entière.
  sainsMasques: true,
  // Vrai dès qu'un verdict de réputation a manqué : l'écran le dit au lieu de laisser
  // croire que tout le lot a été vérifié.
  reputationIncomplete: false,
};

const parEtat = () => {
  const par = {};
  for (const s of state.sites) (par[s.state] ??= []).push(s);
  return par;
};

/**
 * UN SITE SIGNALÉ N'EST PAS UN SITE SAIN, même s'il répond parfaitement.
 *
 * Le 06/10/2026, `gkmtaxzone.com` affichait « site dangereux » dans le navigateur pendant
 * que cet écran annonçait « tous les sites vérifiés répondent normalement » et « 0 à
 * regarder ». Les deux mesures étaient justes : le site rendait bien une page de 57 ko en
 * 0,14 s. Ce que la sonde ne voit pas, c'est la base de réputation que le navigateur
 * consulte AVANT d'ouvrir la page. Elle est désormais lue, et elle compte.
 */
const signale = (s) => s.reputation?.state === 'flagged';
const signales = () => state.sites.filter(signale);
const nonVerifies = () => state.sites.filter((s) => !s.reputation || s.reputation.state === 'unchecked').length;

const compte = (etat) => state.sites.reduce((n, s) => n + (s.state === etat ? 1 : 0), 0);
const sains = () => state.sites.reduce((n, s) => n + (s.state === 'ok' && !signale(s) ? 1 : 0), 0);
const aRegarder = () => state.sites.length - sains();

export const healthAction = {
  key: 'health',
  icon: 'activity',
  labelKey: 'actions.health',
  hintKey: 'health.explain',
  // Cinquante par lot : le service se bride lui-même, mais un lot court laisse l'agent
  // voir l'analyse avancer, et laisse le moteur reprendre près du point d'arrêt.
  batch: 50,
  onChange: null,

  reset() {
    state.sites = [];
    state.charge = null;
    state.sainsMasques = true;
    state.reputationIncomplete = false;
  },

  jobKind: 'health.scan',
  // Aucun réglage n'est envoyé : les seuils du service sont ceux qui ont été mesurés.
  jobParams: () => ({}),

  absorb(server, out) {
    for (const site of out?.sites ?? []) state.sites.push({ ...site, server });
    if (out?.load && (!state.charge || out.load.parCoeur > state.charge.parCoeur)) {
      state.charge = { ...out.load, server };
    }
    if (out?.reputationIncomplete) state.reputationIncomplete = true;
  },

  stats() {
    // Trois chiffres, et pas un quatrième. La charge moyenne d'une machine Linux ne veut
    // rien dire pour qui ne l'a jamais lue : elle a sa place dans une phrase, quand elle
    // explique quelque chose, et non dans une tuile à côté du nombre de sites.
    return [
      ['health.stat_probed', fmtNum(state.sites.length), 'text-ink'],
      ['health.stat_ok', fmtNum(sains()), 'text-accent-700'],
      ['health.stat_problems', fmtNum(aRegarder()), aRegarder() ? 'text-red-600' : 'text-ink-300'],
    ];
  },

  ready: () => state.sites.length > 0,

  // Appelé quand l'analyse s'est terminée SANS rapporter un seul site — tous les lots ont
  // échoué. Dire « tout va bien » ici serait un mensonge : rien n'a été mesuré.
  emptyState: () =>
    h(
      'p',
      { class: 'card px-4 py-6 text-center text-sm text-ink-500' },
      t('health.nothing_measured'),
    ),

  results() {
    if (!state.sites.length) return null;
    const par = parEtat();
    const problemes = aRegarder();
    // Tant que rien ne va mal, la liste entière a du sens ; dès qu'il y a un problème,
    // elle ne sert qu'à le cacher.
    const masquer = state.sainsMasques && problemes > 0;

    return h(
      'div',
      { class: 'space-y-4' },
      noteCharge(),
      // LES SITES SIGNALÉS PASSENT DEVANT TOUT. Ce sont les seuls dont les visiteurs ne
      // voient pas la page du tout : le navigateur affiche un avertissement à la place.
      sectionSignales(),
      noteReputation(),
      problemes === 0
        ? h(
            'p',
            { class: 'flex items-center gap-2 rounded-lg bg-accent-50 px-4 py-3 text-sm font-medium text-accent-700' },
            icon('check'),
            t('health.all_good'),
          )
        : bandeauFiltre(masquer),
      ...ORDRE.filter((etat) => par[etat]?.length && !(masquer && etat === 'ok')).map((etat) => groupe(etat, par[etat])),
    );
  },
};

/**
 * L'adresse où Google explique son verdict, et où la levée se demande.
 *
 * C'est la seule page qui donne la RAISON du signalement, et l'agent n'a pas à la
 * retrouver seul : le lien est à côté du site concerné.
 */
const pageGoogle = (domain) => `https://transparencyreport.google.com/safe-browsing/search?url=${encodeURIComponent(domain)}`;

/**
 * Les sites que le navigateur refuse d'ouvrir, en tête et en rouge.
 *
 * Un site signalé ne perd pas une visite sur dix : il les perd TOUTES, puisque le
 * navigateur affiche un avertissement pleine page à la place du site. C'est, de tout ce
 * que cet écran mesure, ce qui coûte le plus cher — d'où la place et la couleur.
 */
function sectionSignales() {
  const liste = signales();
  if (!liste.length) return null;
  const multi = new Set(state.sites.map((s) => s.server)).size > 1;
  return h(
    'section',
    { class: 'card overflow-hidden border-red-200' },
    h(
      'header',
      { class: 'flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-red-100 bg-red-50 px-4 py-2.5' },
      icon('alert', 'size-4 shrink-0 text-red-600'),
      h('span', { class: 'text-sm font-semibold text-red-700' }, t('health.flagged_title')),
      h('span', { class: 'rounded-md bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700' }, fmtNum(liste.length)),
    ),
    h('p', { class: 'border-b border-ink-50 px-4 py-2 text-xs text-ink-500' }, t('health.flagged_note')),
    h(
      'ul',
      { class: 'divide-y divide-ink-50' },
      liste.map((s) =>
        h(
          'li',
          { class: 'flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm' },
          h('a', { href: `https://${s.domain}/`, target: '_blank', rel: 'noopener', class: 'font-medium text-accent-700 hover:underline' }, s.domain),
          multi ? h('span', { class: 'text-xs text-ink-400' }, s.server) : null,
          h('span', { class: 'flex-1' }),
          // La date du dernier passage de Google : elle dit si le verdict est frais.
          s.reputation?.checkedAt
            ? h('span', { class: 'text-xs whitespace-nowrap text-ink-400' }, t('health.flagged_seen', { date: fmtDate(s.reputation.checkedAt) }))
            : null,
          h(
            'a',
            { href: pageGoogle(s.domain), target: '_blank', rel: 'noopener', class: 'text-xs font-medium text-red-700 hover:underline' },
            t('health.flagged_why'),
          ),
        ),
      ),
    ),
  );
}

/**
 * Ce qui n'a PAS pu être vérifié, dit platement.
 *
 * Un module de sécurité qui se tait quand il n'a rien pu lire laisse croire que tout va
 * bien. La machine de déploiement prévue a ses ports sortants fermés : ce message y sera
 * la règle, et il doit se comprendre sans explication.
 */
function noteReputation() {
  const combien = nonVerifies();
  if (!combien || !state.sites.length) return null;
  return h(
    'p',
    { class: 'flex items-start gap-2 rounded-lg bg-ink-50 px-4 py-3 text-sm text-ink-500' },
    icon('alert', 'size-4 shrink-0 mt-0.5'),
    t('health.rep_unchecked', { count: fmtNum(combien) }),
  );
}

/**
 * La pastille rouge à côté du nom du site, pour que le lien se fasse.
 *
 * Le site reste dans son groupe d'état — il EST en ligne — et la pastille dit l'autre
 * moitié de l'histoire là où l'agent la lit.
 */
function pastilleReputation(s) {
  if (!signale(s)) return null;
  return h(
    'a',
    {
      href: pageGoogle(s.domain),
      target: '_blank',
      rel: 'noopener',
      class: 'rounded bg-red-100 px-1 py-px text-[0.65rem] font-semibold tracking-wide text-red-700 uppercase hover:bg-red-200',
      title: t('health.flagged_note'),
    },
    t('health.flagged_badge'),
  );
}

/**
 * La charge, dite en une phrase et SEULEMENT quand elle explique quelque chose.
 *
 * Un agent qui voit « lent » sur dix sites d'une même machine doit savoir que c'est la
 * machine, et non les dix sites. En dessous du seuil, cette phrase n'apparaît pas : un
 * avertissement permanent ne se lit plus.
 */
function noteCharge() {
  if (!state.charge || state.charge.parCoeur <= 2) return null;
  return h(
    'p',
    { class: 'flex items-start gap-2 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900' },
    icon('alert', 'size-4 shrink-0 mt-0.5'),
    // `fmtNum` et non `toFixed` : « 22,9 » en français, « 22.9 » en anglais. Un séparateur
    // décimal étranger fait buter la lecture d'un chiffre qu'on veut justement limpide.
    t('health.busy_note', { server: state.charge.server, load: fmtNum(Math.round(state.charge.load * 10) / 10), cores: state.charge.cores }),
  );
}

/** La seule commande de l'écran : tout voir, ou seulement ce qui va mal. */
function bandeauFiltre(masquer) {
  return h(
    'label',
    { class: 'flex cursor-pointer items-center gap-2 text-sm text-ink-500' },
    h('input', {
      type: 'checkbox',
      class: 'size-4 rounded border-ink-200 text-accent-600',
      checked: masquer,
      onchange: (e) => {
        state.sainsMasques = e.target.checked;
        healthAction.onChange?.();
      },
    }),
    t('health.only_problems'),
    h('span', { class: 'text-ink-300' }, `(${fmtNum(aRegarder())} / ${fmtNum(state.sites.length)})`),
  );
}

/**
 * Une durée lisible, dans la langue de l'agent.
 *
 * Deux décimales en dessous de la seconde, une au-dessus : « 0,09 s » et « 8,1 s » se
 * lisent, « 8.00 s » fait buter — le séparateur décimal du français est la virgule.
 */
function duree(secondes) {
  if (!secondes) return '—';
  const arrondi = secondes < 1 ? Math.round(secondes * 100) / 100 : Math.round(secondes * 10) / 10;
  // Une page servie en 0,001 s existe : elle sort du cache d'nginx. Afficher « 0 s »
  // laisserait croire à une mesure manquante.
  if (arrondi === 0) return `< ${fmtNum(0.01)} s`;
  return `${fmtNum(arrondi)} s`;
}

/**
 * Le protocole que le site se donne, en pastille à côté de son nom.
 *
 * Pas une colonne : sur cent sites mesurés, cent se déclarent en « https ». Une colonne
 * entière pour répéter la même chose fatigue l'œil ; une pastille discrète se lit d'un
 * coup, et l'exception — un site en « http », c'est-à-dire qui envoie ses visiteurs sur
 * une version non sécurisée de lui-même — ressort en ambre au lieu de se noyer.
 */
function pastilleProtocole(s) {
  if (!s.scheme) return null;
  const faible = s.scheme === 'http';
  return h(
    'span',
    {
      class: `rounded px-1 py-px text-[0.65rem] font-semibold uppercase ${faible ? 'bg-amber-100 text-amber-800' : 'bg-ink-100 text-ink-400'}`,
      // L'adresse exacte que le site déclare : c'est elle qui a servi à décider.
      title: s.canonical ?? s.redirect ?? t('health.col_proto'),
    },
    s.scheme,
  );
}

/** Un état, son nombre, et les sites concernés. */
function groupe(etat, sites) {
  const multi = new Set(state.sites.map((s) => s.server)).size > 1;
  return h(
    'section',
    { class: 'card overflow-hidden' },
    h(
      'header',
      { class: 'flex items-center gap-2 border-b border-ink-100 px-4 py-2.5' },
      h('span', { class: `rounded-md px-2 py-0.5 text-xs font-semibold ${TEINTES[etat] ?? 'bg-ink-100 text-ink-500'}` }, t(`health.state_${etat}`)),
      h('span', { class: 'text-sm font-medium text-ink' }, fmtNum(sites.length)),
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
            h('th', { class: 'px-4 py-2 text-left font-medium' }, t('col.domain')),
            multi ? h('th', { class: 'px-3 py-2 text-left font-medium' }, t('col.server')) : null,
            // La date et le fichier avant les chiffres techniques : c'est ce qu'un agent
            // regarde en second, juste après le nom du site.
            h('th', { class: 'px-3 py-2 text-left font-medium' }, t('health.col_modified')),
            h('th', { class: 'px-3 py-2 text-left font-medium' }, t('health.col_file')),
            h('th', { class: 'px-3 py-2 text-right font-medium' }, t('health.col_code')),
            h('th', { class: 'px-3 py-2 text-right font-medium' }, t('health.col_time')),
            h('th', { class: 'px-4 py-2 text-right font-medium' }, t('health.col_size')),
          ),
        ),
        h(
          'tbody',
          {},
          sites.map((s) =>
            h(
              'tr',
              { class: 'border-t border-ink-50' },
              h(
                'td',
                { class: 'px-4 py-1.5' },
                h(
                  'span',
                  { class: 'flex items-center gap-1.5' },
                  // Le lien ouvre le site tel qu'un visiteur le voit : c'est la première
                  // chose que fait l'agent après avoir lu une ligne rouge.
                  h('a', { href: `https://${s.domain}/`, target: '_blank', rel: 'noopener', class: 'text-accent-700 hover:underline' }, s.domain),
                  pastilleProtocole(s),
                  pastilleReputation(s),
                ),
              ),
              multi ? h('td', { class: 'px-3 py-1.5 text-ink-400' }, s.server) : null,
              // `fmtDate` traduit dans le fuseau de l'agent : les serveurs vivent en UTC et
              // l'agent trois heures devant. Une date brute l'aurait fait chercher en vain.
              h('td', { class: 'px-3 py-1.5 whitespace-nowrap text-ink-500' }, s.modifiedAt ? fmtDate(s.modifiedAt) : '—'),
              h(
                'td',
                { class: 'max-w-[18rem] truncate px-3 py-1.5 text-ink-400', title: s.modifiedFile ?? '' },
                s.modifiedFile ?? '—',
              ),
              h('td', { class: 'px-3 py-1.5 text-right tabular-nums text-ink-500' }, s.code || '—'),
              h('td', { class: 'px-3 py-1.5 text-right tabular-nums text-ink-500' }, duree(s.time)),
              h('td', { class: 'px-4 py-1.5 text-right tabular-nums text-ink-500' }, s.bytes ? fmtSize(s.bytes) : '—'),
            ),
          ),
        ),
      ),
    ),
    // Une destination de renvoi ne tient pas dans une colonne, mais c'est elle qui
    // explique l'état : elle est donnée en pied de groupe.
    etat === 'redirect'
      ? h(
          'ul',
          { class: 'border-t border-ink-100 bg-ink-50 px-4 py-2 text-xs text-ink-500' },
          sites.slice(0, 20).map((s) => h('li', { class: 'truncate' }, `${s.domain} → ${s.redirect ?? '—'}`)),
        )
      : null,
  );
}

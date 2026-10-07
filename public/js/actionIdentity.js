/**
 * L'IDENTITÉ DE CHAQUE ACTION : ce qu'elle est, et surtout ce qu'elle fait au parc.
 *
 * LA DISTINCTION QUI COMPTE N'EST PAS DÉCORATIVE. Jusqu'ici, les huit traitements se
 * présentaient de la même façon, et rien ne disait à l'agent lequel se contente de LIRE
 * et lequel ÉCRIT sur des sites en production. Ce renseignement-là vaut mieux qu'une
 * couleur par action : il change ce que l'agent risque en cliquant.
 *
 * DEUX FAMILLES, ET ELLES SE LISENT DE LOIN :
 *
 *   - « lecture seule » : la sonde demande des pages, lit des fichiers, compte. Rien
 *     n'est modifié nulle part, et l'agent peut lancer sans arrière-pensée ;
 *   - « écrit sur les sites » : le traitement modifie des fichiers sur des machines de
 *     production. Toutes ces actions passent par une vérification avant d'écrire, et
 *     c'est précisément pour cela que l'étiquette doit être visible AVANT.
 *
 * La famille n'est pas devinée : elle est déclarée ici, et un essai vérifie qu'aucune
 * action du catalogue n'y manque. Une action oubliée serait présentée comme inoffensive
 * par défaut — exactement l'erreur à ne pas commettre, d'où l'essai.
 *
 * CE QUI VARIE D'UNE ACTION À L'AUTRE, à l'écran : son icône, son nom, sa phrase, sa
 * famille, ses propres chiffres et ses propres résultats. CE QUI NE VARIE PAS : la
 * charpente — bandeau sombre, ligne d'état en chasse fixe, mêmes étapes numérotées. On
 * reconnaît l'outil, on distingue le traitement.
 */

/** Ne modifie rien, nulle part. */
export const LECTURE = 'read';

/** Modifie des fichiers sur des machines de production. */
export const ECRITURE = 'write';

/**
 * Chaque action et sa famille.
 *
 * Relevé dans `src/services/jobKinds.js` et dans les routes, et non supposé : les trois
 * premières n'ont que des tournées en `bulk.read`, les cinq autres ont une route
 * `/apply` protégée par `bulk.apply` et `design.publish`.
 */
export const FAMILLES = Object.freeze({
  health: LECTURE,
  urls: LECTURE,
  duplicates: LECTURE,
  translate: ECRITURE,
  templates: ECRITURE,
  categories: ECRITURE,
  themes: ECRITURE,
  redirects: ECRITURE,
});

/**
 * La famille d'une action.
 *
 * Une action inconnue est traitée comme ÉCRIVANTE. C'est le sens prudent : annoncer à
 * tort « lecture seule » sur un traitement qui modifie des sites serait un mensonge aux
 * conséquences réelles, alors qu'une mise en garde de trop ne coûte qu'une seconde.
 */
export const familleDe = (key) => FAMILLES[key] ?? ECRITURE;

export const estLecture = (key) => familleDe(key) === LECTURE;

/** Ce que l'étiquette dit, et la couleur qu'elle porte. */
export const ETIQUETTES = Object.freeze({
  [LECTURE]: {
    labelKey: 'actions.family_read',
    hintKey: 'actions.family_read_hint',
    // Vert de la charte : c'est la couleur du « rien à craindre » dans tout le logiciel.
    classes: 'bg-accent-100 text-accent-700',
    point: 'bg-accent-600',
  },
  [ECRITURE]: {
    labelKey: 'actions.family_write',
    hintKey: 'actions.family_write_hint',
    // Ambre, et non rouge : ces actions sont normales et attendues, elles demandent
    // seulement qu'on sache ce qu'on fait. Le rouge est réservé à ce qui va mal.
    classes: 'bg-amber-100 text-amber-800',
    point: 'bg-amber-500',
  },
});

export const etiquetteDe = (key) => ETIQUETTES[familleDe(key)];

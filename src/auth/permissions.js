/**
 * Catalogue des permissions (RBAC).
 *
 * Il est défini dans le code, et non en base : une permission n'existe que si une route
 * la vérifie. La base ne stocke que les ATTRIBUTIONS (rôle → permissions), ce qui évite
 * des permissions orphelines après une mise à jour.
 * Les libellés sont traduits via les clés « perm.<clé> » et « perm_group.<groupe> ».
 */

export const PERMISSION_GROUPS = ['servers', 'domains', 'design', 'bulk', 'files', 'cloudflare', 'admin'];

export const PERMISSIONS = [
  { key: 'servers.connect', group: 'servers' },
  { key: 'domains.read', group: 'domains' },
  { key: 'domains.create', group: 'domains' },
  { key: 'domains.delete', group: 'domains' },
  { key: 'domains.lock', group: 'domains' },
  { key: 'domains.fix_perms', group: 'domains' },
  // Design et contenu : préparer un brouillon et le publier sont deux droits distincts,
  // pour qu'un rédacteur puisse proposer sans mettre en ligne.
  { key: 'design.read', group: 'design' },
  { key: 'design.edit', group: 'design' },
  { key: 'design.publish', group: 'design' },
  // TRAITEMENTS DE MASSE : un droit à part, et c'est tout l'objet de ce groupe.
  //
  // Publier la page d'un site qu'on est en train d'éditer, et relancer une traduction
  // sur les 7 733 sites d'un VPS, ne sont pas le même geste — même si, techniquement,
  // le second n'est que le premier répété. L'écran « Actions » s'ouvrait avec le simple
  // droit de lire le design, et s'exécutait avec celui de publier : un rédacteur de
  // contenu pouvait donc lancer une tournée sur tout le parc.
  //
  // Lire et appliquer sont séparés parce que l'écran lui-même l'est : l'analyse ne
  // modifie rien et sert à décider ; l'application écrit sur des milliers de sites en
  // production. On peut vouloir confier la première sans la seconde.
  { key: 'bulk.read', group: 'bulk' },
  { key: 'bulk.apply', group: 'bulk' },
  { key: 'files.read', group: 'files' },
  { key: 'files.write', group: 'files' },
  { key: 'files.delete', group: 'files' },
  // Cloudflare : lire l'etat d'une zone n'engage rien ; changer un reglage touche un
  // site en production, et purger un cache le fait repartir de zero. Trois droits
  // distincts, pour qu'un agent puisse consulter sans pouvoir agir.
  { key: 'cloudflare.read', group: 'cloudflare' },
  { key: 'cloudflare.write', group: 'cloudflare' },
  { key: 'cloudflare.purge', group: 'cloudflare' },
  { key: 'users.manage', group: 'admin' },
  // Lire le journal, c'est voir ce que font les autres : un droit de supervision,
  // distinct de la gestion des comptes, qu'on peut accorder sans donner les clés.
  { key: 'audit.read', group: 'admin' },
];

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);
export const isPermission = (key) => PERMISSION_KEYS.includes(key);

/** Rôles fournis d'origine : leurs permissions sont resynchronisées à chaque démarrage. */
export const SYSTEM_ROLES = [
  { key: 'admin', name: 'Administrateur', permissions: PERMISSION_KEYS },
  {
    key: 'operator',
    name: 'Opérateur',
    permissions: [
      'servers.connect', 'domains.read', 'domains.lock', 'domains.fix_perms',
      'design.read', 'design.edit', 'design.publish',
      // L'opérateur est celui qui fait les tournées de fond : c'est son métier.
      'bulk.read', 'bulk.apply',
      'files.read', 'files.write', 'files.delete',
      'cloudflare.read', 'cloudflare.purge',
    ],
  },
  {
    key: 'editor',
    name: 'Éditeur',
    // L'éditeur peut REGARDER ce qu'un traitement de masse ferait, sans pouvoir le
    // lancer : « montre-moi » ne coûte rien, « applique » touche des milliers de sites.
    permissions: ['servers.connect', 'domains.read', 'design.read', 'design.edit', 'design.publish', 'bulk.read', 'files.read', 'files.write', 'cloudflare.read'],
  },
  // Rédacteur : prépare et prévisualise, mais ne met jamais en ligne.
  { key: 'contributor', name: 'Rédacteur', permissions: ['servers.connect', 'domains.read', 'design.read', 'design.edit', 'files.read'] },
  { key: 'viewer', name: 'Lecteur', permissions: ['servers.connect', 'domains.read', 'design.read', 'files.read', 'cloudflare.read'] },
];

/** Le rôle « admin » ne peut pas être vidé de ses droits : il reste la porte de sortie. */
export const PROTECTED_ROLE = 'admin';

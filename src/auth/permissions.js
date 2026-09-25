/**
 * Catalogue des permissions (RBAC).
 *
 * Il est défini dans le code, et non en base : une permission n'existe que si une route
 * la vérifie. La base ne stocke que les ATTRIBUTIONS (rôle → permissions), ce qui évite
 * des permissions orphelines après une mise à jour.
 * Les libellés sont traduits via les clés « perm.<clé> » et « perm_group.<groupe> ».
 */

export const PERMISSION_GROUPS = ['servers', 'domains', 'design', 'files', 'admin'];

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
  { key: 'files.read', group: 'files' },
  { key: 'files.write', group: 'files' },
  { key: 'files.delete', group: 'files' },
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
      'files.read', 'files.write', 'files.delete',
    ],
  },
  {
    key: 'editor',
    name: 'Éditeur',
    permissions: ['servers.connect', 'domains.read', 'design.read', 'design.edit', 'design.publish', 'files.read', 'files.write'],
  },
  // Rédacteur : prépare et prévisualise, mais ne met jamais en ligne.
  { key: 'contributor', name: 'Rédacteur', permissions: ['servers.connect', 'domains.read', 'design.read', 'design.edit', 'files.read'] },
  { key: 'viewer', name: 'Lecteur', permissions: ['servers.connect', 'domains.read', 'design.read', 'files.read'] },
];

/** Le rôle « admin » ne peut pas être vidé de ses droits : il reste la porte de sortie. */
export const PROTECTED_ROLE = 'admin';

/**
 * Le schéma MySQL / MariaDB.
 *
 * Il reprend celui de SQLite, mais traduit plutôt que recopié. Ce qui change, et
 * pourquoi :
 *
 *   - les clés primaires deviennent `INT AUTO_INCREMENT` : SQLite donne un identifiant
 *     à toute colonne `INTEGER PRIMARY KEY`, MySQL réclame le mot ;
 *   - les `TEXT` qui servent d'index ou de clé deviennent des `VARCHAR` de taille
 *     choisie. MySQL refuse d'indexer un TEXT sans longueur, et un VARCHAR trop large
 *     épuise la limite de 3072 octets d'un index — en utf8mb4, chaque caractère en
 *     compte jusqu'à quatre ;
 *   - les booléens de SQLite, stockés en entier, deviennent `TINYINT(1)`, que
 *     phpMyAdmin affiche comme des cases ;
 *   - `PRAGMA user_version` n'existe pas : une table `schema_version` tient le compte.
 *
 * Les horodatages restent des entiers en millisecondes, comme dans le reste du code.
 * `BIGINT` est indispensable : un `INT` déborde en 2038.
 *
 * Chaque table et chaque colonne porte un COMMENT. phpMyAdmin les affiche, et c'est
 * précisément l'usage demandé : pouvoir lire ces données sans lire le code.
 */

export const MYSQL_MIGRATIONS = [
  // v1 — rôles, permissions, utilisateurs, portée par serveur, sessions
  `
  CREATE TABLE roles (
    id INT AUTO_INCREMENT PRIMARY KEY,
    \`key\` VARCHAR(60) NOT NULL UNIQUE COMMENT 'identifiant stable du rôle',
    name VARCHAR(120) NOT NULL COMMENT 'nom affiché',
    is_system TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1 = rôle fourni d''origine',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Rôles : administrateur, opérateur, éditeur…';

  CREATE TABLE role_permissions (
    role_id INT NOT NULL,
    permission VARCHAR(60) NOT NULL COMMENT 'une permission du catalogue, ex. design.publish',
    PRIMARY KEY (role_id, permission),
    CONSTRAINT fk_roleperm_role FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Ce que chaque rôle a le droit de faire';

  CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(80) NOT NULL UNIQUE COMMENT 'identifiant de connexion',
    display_name VARCHAR(120) NOT NULL DEFAULT '' COMMENT 'nom affiché dans le journal',
    email VARCHAR(190) NOT NULL DEFAULT '',
    password_hash VARCHAR(255) NOT NULL COMMENT 'empreinte scrypt, jamais le mot de passe',
    role_id INT NOT NULL,
    is_active TINYINT(1) NOT NULL DEFAULT 1,
    must_change_password TINYINT(1) NOT NULL DEFAULT 0,
    scope_all_servers TINYINT(1) NOT NULL DEFAULT 1 COMMENT '1 = accès à tous les serveurs',
    failed_attempts INT NOT NULL DEFAULT 0,
    locked_until BIGINT NULL COMMENT 'verrouillage après échecs répétés, en ms',
    last_login_at BIGINT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES roles(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Comptes des agents';

  CREATE TABLE user_servers (
    user_id INT NOT NULL,
    server_id VARCHAR(60) NOT NULL,
    PRIMARY KEY (user_id, server_id),
    CONSTRAINT fk_userserver_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Serveurs accessibles à un compte à portée restreinte';

  CREATE TABLE sessions (
    sid VARCHAR(128) PRIMARY KEY,
    user_id INT NULL,
    data TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    INDEX idx_sessions_expires (expires_at),
    CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Sessions ouvertes, pour survivre à un redémarrage';
  `,

  // v2 — brouillons de design et de contenu
  `
  CREATE TABLE site_drafts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    server_id VARCHAR(60) NOT NULL,
    domain VARCHAR(190) NOT NULL,
    kind VARCHAR(20) NOT NULL DEFAULT 'site' COMMENT 'site ou article',
    target VARCHAR(190) NOT NULL DEFAULT '' COMMENT 'chemin de l''article, vide pour le site',
    data LONGTEXT NOT NULL COMMENT 'le brouillon, en JSON',
    base_hash VARCHAR(64) NOT NULL COMMENT 'empreinte du fichier au moment de la lecture',
    preview_token VARCHAR(64) NULL,
    preview_at BIGINT NULL,
    created_by INT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    UNIQUE KEY uq_draft (server_id, domain, kind, target),
    INDEX idx_drafts_domain (server_id, domain),
    CONSTRAINT fk_draft_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Modifications préparées, pas encore publiées';
  `,

  // v3 — dictionnaire des agents
  `
  CREATE TABLE lang_phrases (
    id INT AUTO_INCREMENT PRIMARY KEY,
    source VARCHAR(400) NOT NULL COMMENT 'expression d''origine',
    lang VARCHAR(10) NOT NULL,
    target TEXT NOT NULL COMMENT 'traduction retenue',
    created_by INT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    UNIQUE KEY uq_phrase (source, lang),
    CONSTRAINT fk_phrase_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Expressions que le dictionnaire du parc ignore';
  `,

  // v4 — journal d'audit
  `
  CREATE TABLE audit_events (
    id INT AUTO_INCREMENT PRIMARY KEY,
    at BIGINT NOT NULL COMMENT 'quand, en millisecondes',
    user_id INT NULL COMMENT 'sans clé étrangère : un événement survit au compte qu''il nomme',
    username VARCHAR(80) NOT NULL DEFAULT '',
    display_name VARCHAR(120) NOT NULL DEFAULT '',
    role VARCHAR(60) NOT NULL DEFAULT '',
    action VARCHAR(80) NOT NULL COMMENT 'ex. design.publish, cloudflare.purge',
    family VARCHAR(20) NOT NULL DEFAULT 'other' COMMENT 'create, update, delete, auth, read',
    server_id VARCHAR(60) NULL,
    domain VARCHAR(190) NULL,
    target VARCHAR(400) NULL COMMENT 'ce sur quoi l''action a porté',
    ok TINYINT(1) NOT NULL DEFAULT 1,
    error VARCHAR(400) NULL,
    ip VARCHAR(45) NULL,
    INDEX idx_audit_at (at DESC),
    INDEX idx_audit_user (username, at DESC),
    INDEX idx_audit_action (action, at DESC),
    INDEX idx_audit_domain (domain, at DESC)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Qui a fait quoi, sur quoi, quand, avec quel résultat';
  `,

  // v5 — Cloudflare
  `
  CREATE TABLE cf_accounts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    account_id VARCHAR(40) NOT NULL UNIQUE COMMENT 'identifiant du compte chez Cloudflare',
    name VARCHAR(190) NOT NULL DEFAULT '',
    email VARCHAR(190) NOT NULL DEFAULT '' COMMENT 'exigé par Cloudflare avec une clé globale',
    global_api_key VARCHAR(80) NOT NULL DEFAULT '' COMMENT 'accès TOTAL au compte',
    api_token VARCHAR(220) NOT NULL DEFAULT '' COMMENT 'jeton à portée limitée, préférable',
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    verified_at BIGINT NULL COMMENT 'dernière vérification réussie des accès',
    last_error VARCHAR(400) NULL,
    INDEX idx_cf_accounts_email (email)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Comptes Cloudflare et leurs accès';

  CREATE TABLE cf_zones (
    id INT AUTO_INCREMENT PRIMARY KEY,
    domain VARCHAR(190) NOT NULL UNIQUE,
    zone_id VARCHAR(40) NOT NULL DEFAULT '' COMMENT 'identifiant de la zone chez Cloudflare',
    account_ref INT NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT '' COMMENT 'active, pending…',
    plan VARCHAR(60) NOT NULL DEFAULT '',
    name_servers VARCHAR(400) NOT NULL DEFAULT '',
    ssl_mode VARCHAR(20) NOT NULL DEFAULT '' COMMENT 'off, flexible, full, strict',
    always_https TINYINT(1) NULL COMMENT 'redirection http vers https',
    checked_at BIGINT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    INDEX idx_cf_zones_account (account_ref),
    INDEX idx_cf_zones_zone (zone_id),
    CONSTRAINT fk_cfzone_account FOREIGN KEY (account_ref) REFERENCES cf_accounts(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Un domaine, sa zone Cloudflare et son état';

  CREATE TABLE cf_imports (
    id INT AUTO_INCREMENT PRIMARY KEY,
    at BIGINT NOT NULL,
    source VARCHAR(190) NOT NULL DEFAULT '',
    rows_read INT NOT NULL DEFAULT 0,
    accounts_added INT NOT NULL DEFAULT 0,
    zones_added INT NOT NULL DEFAULT 0,
    zones_updated INT NOT NULL DEFAULT 0,
    skipped INT NOT NULL DEFAULT 0,
    report LONGTEXT NOT NULL COMMENT 'le détail de l''import, en JSON'
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Historique des imports : ce qui est entré, ce qui a été écarté';
  `,
];

/**
 * Applique les migrations manquantes.
 *
 * `PRAGMA user_version` n'existe pas ici : une table tient le compte, et chaque
 * migration y inscrit sa ligne. Elle garde aussi la date, ce qui aide à comprendre
 * l'état d'une installation qu'on découvre.
 */
export async function migrateMysql(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INT NOT NULL PRIMARY KEY,
      applied_at BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Migrations appliquées'
  `);

  const ligne = await db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_version').get();
  const courante = Number(ligne?.v ?? 0);
  const faites = [];

  for (let v = courante; v < MYSQL_MIGRATIONS.length; v += 1) {
    await db.exec(MYSQL_MIGRATIONS[v]);
    await db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(v + 1, Date.now());
    faites.push(v + 1);
  }
  return { from: courante, to: MYSQL_MIGRATIONS.length, applied: faites };
}

/**
 * Remet les rôles d'origine en accord avec le catalogue du code.
 *
 * Appelé à chaque démarrage : une permission ajoutée au code apparaît aussitôt dans les
 * rôles fournis, et une permission supprimée disparaît de TOUS les rôles, personnalisés
 * compris. Sans cette purge, un rôle continuerait de porter un droit qui ne veut plus
 * rien dire, et le contrôle d'accès deviendrait illisible.
 */
export async function seedSystemRolesMysql(db, { SYSTEM_ROLES, PERMISSION_KEYS }) {
  const { transaction } = await import('./mysql.js');
  void db;
  await transaction(async (tx) => {
    for (const role of SYSTEM_ROLES) {
      await tx.prepare(
        'INSERT INTO roles (`key`, name, is_system) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE name = VALUES(name), is_system = 1',
      ).run(role.key, role.name);
      const { id } = await tx.prepare('SELECT id FROM roles WHERE `key` = ?').get(role.key);
      await tx.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(id);
      for (const permission of role.permissions) {
        await tx.prepare('INSERT IGNORE INTO role_permissions (role_id, permission) VALUES (?, ?)').run(id, permission);
      }
    }
    // Les permissions disparues du catalogue s'en vont, où qu'elles soient.
    const trous = PERMISSION_KEYS.map(() => '?').join(', ');
    await tx.prepare(`DELETE FROM role_permissions WHERE permission NOT IN (${trous})`).run(...PERMISSION_KEYS);
  });
}

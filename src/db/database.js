import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PERMISSION_KEYS, SYSTEM_ROLES } from '../auth/permissions.js';

// Chargement différé : un import statique serait évalué AVANT le filtre d'avertissement
// installé ci-dessous, et le message « expérimental » apparaîtrait malgré tout.
const require = createRequire(import.meta.url);

/**
 * Accès SQLite (module natif `node:sqlite`, aucune dépendance ni compilation).
 *
 * Tout l'accès au moteur est confiné à ce fichier : changer de moteur ne toucherait
 * que ce module. L'avertissement « expérimental » de Node est filtré ici, et seulement
 * celui-ci, pour ne pas polluer les journaux.
 */
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  if (String(warning).includes('SQLite is an experimental feature')) return;
  emitWarning.call(process, warning, ...rest);
};

const MIGRATIONS = [
  // v1 — rôles, permissions, utilisateurs, portée par serveur, sessions persistantes
  `
  CREATE TABLE roles (
    id INTEGER PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    is_system INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE role_permissions (
    role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission TEXT NOT NULL,
    PRIMARY KEY (role_id, permission)
  );

  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    role_id INTEGER NOT NULL REFERENCES roles(id),
    is_active INTEGER NOT NULL DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    scope_all_servers INTEGER NOT NULL DEFAULT 1,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER,
    last_login_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE user_servers (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    server_id TEXT NOT NULL,
    PRIMARY KEY (user_id, server_id)
  );

  CREATE TABLE sessions (
    sid TEXT PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    data TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX idx_sessions_expires ON sessions(expires_at);
  `,

  // v2 — brouillons de design et de contenu (un par domaine), conservés côté back-office
  `
  CREATE TABLE site_drafts (
    id INTEGER PRIMARY KEY,
    server_id TEXT NOT NULL,
    domain TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'site',
    target TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL,
    base_hash TEXT NOT NULL,
    preview_token TEXT,
    preview_at INTEGER,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (server_id, domain, kind, target)
  );
  CREATE INDEX idx_drafts_domain ON site_drafts(server_id, domain);
  `,

  // v3 — dictionnaire des agents : les expressions que le dictionnaire du parc ignore
  `
  CREATE TABLE lang_phrases (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    lang TEXT NOT NULL,
    target TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (source, lang)
  );
  `,
];

let db = null;

export function openDatabase(file) {
  if (db) return db;
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  seedSystemRoles(db);
  return db;
}

export function getDb() {
  if (!db) throw new Error('Base de données non ouverte : appelez openDatabase() au démarrage.');
  return db;
}

export function closeDatabase() {
  db?.close();
  db = null;
}

function migrate(d) {
  const { user_version: current } = d.prepare('PRAGMA user_version').get();
  for (let v = current; v < MIGRATIONS.length; v++) {
    d.exec('BEGIN');
    try {
      d.exec(MIGRATIONS[v]);
      d.exec(`PRAGMA user_version = ${v + 1}`);
      d.exec('COMMIT');
    } catch (err) {
      d.exec('ROLLBACK');
      throw new Error(`Migration ${v + 1} échouée : ${err.message}`);
    }
  }
}

/**
 * Resynchronise les rôles fournis d'origine avec le catalogue du code : un rôle ajouté
 * dans une nouvelle version apparaît, et une permission retirée du catalogue disparaît
 * des attributions. Les rôles personnalisés ne sont jamais touchés.
 */
export function seedSystemRoles(d) {
  d.exec('BEGIN');
  try {
    const insertRole = d.prepare('INSERT INTO roles (key, name, is_system) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET name = excluded.name');
    const roleId = d.prepare('SELECT id FROM roles WHERE key = ?');
    const clear = d.prepare('DELETE FROM role_permissions WHERE role_id = ?');
    const grant = d.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission) VALUES (?, ?)');
    for (const role of SYSTEM_ROLES) {
      insertRole.run(role.key, role.name);
      const { id } = roleId.get(role.key);
      clear.run(id);
      for (const permission of role.permissions) grant.run(id, permission);
    }
    // Purge des permissions disparues du catalogue (rôles personnalisés compris).
    const placeholders = PERMISSION_KEYS.map(() => '?').join(', ');
    d.prepare(`DELETE FROM role_permissions WHERE permission NOT IN (${placeholders})`).run(...PERMISSION_KEYS);
    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const env = process.env;
const int = (v, d) => (/^\d+$/.test(v ?? '') ? Number(v) : d);
const bool = (v, d) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const file = (v, d) => path.resolve(ROOT, v || d);

export const config = {
  host: env.HOST || '127.0.0.1',
  port: int(env.PORT, 3000),
  secureCookies: bool(env.SECURE_COOKIES, false),
  sessionSecret: env.SESSION_SECRET || '',
  admin: { user: env.ADMIN_USER || 'admin', passwordHash: env.ADMIN_PASSWORD_HASH || '' },
  defaultLang: env.DEFAULT_LANG || 'fr',
  ssh: {
    readyTimeout: int(env.SSH_READY_TIMEOUT_MS, 15000),
    commandTimeout: int(env.SSH_COMMAND_TIMEOUT_MS, 60000),
    idleTimeout: int(env.SSH_IDLE_TIMEOUT_MS, 15 * 60000),
    maxParallel: Math.max(1, int(env.SSH_MAX_PARALLEL, 4)),
    strictHostKey: bool(env.SSH_STRICT_HOST_KEY, false),
  },
  cacheTtl: int(env.DOMAIN_CACHE_TTL_MS, 120000),
  // Clé DeepL facultative : sans elle, l'écran de traduction reste utilisable, l'agent
  // saisissant lui-même les textes que le dictionnaire du parc ne connaît pas.
  deeplKey: env.DEEPL_KEY || '',
  files: {
    maxEntries: int(env.FILES_MAX_ENTRIES, 2000),
    maxEditBytes: int(env.FILES_MAX_EDIT_BYTES, 2 * 1024 * 1024),
    maxArchiveBytes: int(env.FILES_MAX_ARCHIVE_BYTES, 200 * 1024 * 1024),
    maxArchiveEntries: int(env.FILES_MAX_ARCHIVE_ENTRIES, 20000),
    maxBatch: int(env.FILES_MAX_BATCH, 200),
    maxUploadBytes: int(env.FILES_MAX_UPLOAD_BYTES, 200 * 1024 * 1024),
  },
  dbFile: file(env.DB_FILE, 'data/lkm-bo.db'),
  passwordMinLength: int(env.PASSWORD_MIN_LENGTH, 12),
  loginMaxAttempts: int(env.LOGIN_MAX_ATTEMPTS, 10),
  loginRateLimit: int(env.LOGIN_RATE_LIMIT, 20),
  loginLockMinutes: int(env.LOGIN_LOCK_MINUTES, 15),
  serversFile: file(env.SERVERS_FILE, 'config/servers.json'),
  knownHostsFile: file(env.KNOWN_HOSTS_FILE, 'config/known_hosts.json'),
  auditLog: file(env.AUDIT_LOG, 'logs/audit.log'),
};

/** Refuse de démarrer avec une configuration dangereuse ou incomplète. */
export function assertStartupConfig() {
  const problems = [];
  if (config.sessionSecret.length < 32) problems.push('SESSION_SECRET doit contenir au moins 32 caractères (npm run set-password le génère).');
  // Les comptes vivent désormais en base : ADMIN_PASSWORD_HASH ne sert qu'à reprendre
  // l'ancien compte au premier démarrage. Sans lui, un mot de passe est généré et affiché.
  if (problems.length) throw new Error(`Configuration .env incomplète :\n  - ${problems.join('\n  - ')}`);
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const clone = (v) => (isObj(v) ? merge(v, {}) : Array.isArray(v) ? [...v] : v);

/**
 * Fusion « defaults » → serveur, avec CLONAGE des objets imbriqués.
 * Sans ce clonage, tous les serveurs partageraient le même objet `lockop` : le premier
 * traité y inscrivait son hôte, et les suivants héritaient de cette adresse — les
 * verrouillages partaient alors tous vers le mauvais serveur.
 */
function merge(base, over) {
  const out = {};
  for (const [k, v] of Object.entries(base ?? {})) out[k] = clone(v);
  for (const [k, v] of Object.entries(over ?? {})) out[k] = isObj(v) && isObj(base?.[k]) ? merge(base[k], v) : clone(v);
  return out;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const AUTH_TYPES = ['key', 'password', 'agent'];

function checkAuth(auth, where) {
  if (!AUTH_TYPES.includes(auth?.type)) throw new Error(`${where}.auth.type doit valoir ${AUTH_TYPES.join(' | ')}`);
  if (auth.type === 'key' && !auth.keyPathEnv) throw new Error(`${where}.auth.keyPathEnv manquant`);
  if (auth.type === 'password' && !auth.passwordEnv) throw new Error(`${where}.auth.passwordEnv manquant`);
}

/**
 * Charge config/servers.json : chaque serveur hérite du bloc "defaults".
 * Aucun secret ici : seulement des NOMS de variables d'environnement.
 */
export function loadServers(filePath = config.serversFile) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Fichier serveurs introuvable : ${filePath}\n  → copiez config/servers.example.json vers config/servers.json`);
  }
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const seen = new Set();

  return (raw.servers ?? []).map((entry, i) => {
    const s = merge(raw.defaults ?? {}, entry);
    const where = `servers[${i}]`;
    if (!ID_RE.test(s.id ?? '')) throw new Error(`${where}.id invalide (a-z, 0-9, tirets)`);
    if (seen.has(s.id)) throw new Error(`${where}.id dupliqué : ${s.id}`);
    seen.add(s.id);
    if (!s.host || !s.username) throw new Error(`${where} : host et username sont obligatoires`);
    if (!String(s.wwwRoot ?? '').startsWith('/')) throw new Error(`${where}.wwwRoot doit être un chemin absolu`);
    checkAuth(s.auth, where);

    s.port = Number(s.port) || 22;
    s.label ??= s.id;
    s.group ??= 'default';
    s.commands ??= {};
    if (s.lockop) {
      s.lockop.host ??= s.host;
      s.lockop.port = Number(s.lockop.port) || 22;
      checkAuth(s.lockop.auth, `${where}.lockop`);
    }
    return Object.freeze(s);
  });
}

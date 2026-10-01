#!/usr/bin/env node
/**
 * Transfère les données de SQLite vers MySQL / MariaDB.
 *
 *   npm run migrate:mysql            montre ce qui serait transféré
 *   npm run migrate:mysql -- --yes   transfère pour de bon
 *
 * Deux règles, comme ailleurs dans ce dépôt : rien ne s'écrit sans « --yes », et le
 * résultat se raconte table par table. La base SQLite n'est jamais modifiée — elle
 * reste intacte, ce qui permet de recommencer ou de revenir en arrière.
 *
 * L'ordre des tables suit les clés étrangères : un rôle avant ses permissions, un
 * compte Cloudflare avant ses zones. Les identifiants d'origine sont conservés, pour
 * que les liens entre tables restent valides sans avoir à les retraduire.
 */
import { closeDatabase, getDb, openDatabase } from '../src/db/database.js';
import { closeMysql, exec, insertMany, mysqlInfo, openMysql, prepare } from '../src/db/mysql.js';
import { migrateMysql } from '../src/db/mysqlSchema.js';
import { config } from '../src/config.js';

const COULEUR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (COULEUR ? `\u001b[${code}m${s}\u001b[0m` : String(s));
const gras = (s) => c('1', s);
const vert = (s) => c('32', s);
const rouge = (s) => c('31', s);
const orange = (s) => c('33', s);
const gris = (s) => c('90', s);
const nombre = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/**
 * Les tables, dans l'ordre où elles doivent entrer.
 * `cols` nomme les colonnes à reprendre ; ce qui n'y figure pas garde sa valeur par
 * défaut. `fix` ajuste une ligne quand les deux dialectes ne s'accordent pas.
 */
const TABLES = [
  { nom: 'roles', cols: ['id', 'key', 'name', 'is_system'] },
  { nom: 'role_permissions', cols: ['role_id', 'permission'] },
  { nom: 'users', cols: ['id', 'username', 'display_name', 'email', 'password_hash', 'role_id', 'is_active', 'must_change_password', 'scope_all_servers', 'failed_attempts', 'locked_until', 'last_login_at', 'created_at', 'updated_at'] },
  { nom: 'user_servers', cols: ['user_id', 'server_id'] },
  // Les sessions ne sont pas reprises : elles expirent, et forcer une reconnexion au
  // changement de base vaut mieux que de transporter des jetons d'authentification.
  { nom: 'site_drafts', cols: ['id', 'server_id', 'domain', 'kind', 'target', 'data', 'base_hash', 'preview_token', 'preview_at', 'created_by', 'created_at', 'updated_at'] },
  { nom: 'lang_phrases', cols: ['id', 'source', 'lang', 'target', 'created_by', 'created_at', 'updated_at'] },
  { nom: 'audit_events', cols: ['id', 'at', 'user_id', 'username', 'display_name', 'role', 'action', 'family', 'server_id', 'domain', 'target', 'ok', 'error', 'ip'] },
  { nom: 'cf_accounts', cols: ['id', 'account_id', 'name', 'email', 'global_api_key', 'api_token', 'created_at', 'updated_at', 'verified_at', 'last_error'] },
  { nom: 'cf_zones', cols: ['id', 'domain', 'zone_id', 'account_ref', 'status', 'plan', 'name_servers', 'ssl_mode', 'always_https', 'checked_at', 'created_at', 'updated_at'] },
  { nom: 'cf_imports', cols: ['id', 'at', 'source', 'rows_read', 'accounts_added', 'zones_added', 'zones_updated', 'skipped', 'report'] },
];

/** Les champs texte de SQLite peuvent dépasser ce que MySQL accepte dans un VARCHAR. */
const borner = (v, max) => (typeof v === 'string' && v.length > max ? v.slice(0, max) : v);

const LIMITES = {
  audit_events: { target: 400, error: 400, ip: 45, action: 80, username: 80, display_name: 120, role: 60, domain: 190, server_id: 60 },
  cf_accounts: { last_error: 400, email: 190, name: 190, global_api_key: 80, api_token: 220 },
  cf_zones: { name_servers: 400, domain: 190, plan: 60, status: 30 },
  lang_phrases: { source: 400 },
  users: { username: 80, display_name: 120, email: 190 },
  site_drafts: { domain: 190, target: 190, server_id: 60 },
};

const [, , ...argv] = process.argv;
const options = Object.fromEntries(argv.filter((a) => a.startsWith('--')).map((a) => [a.slice(2).split('=')[0], a.includes('=') ? a.split('=')[1] : true]));

console.log(`\n${gras('Transfert de SQLite vers MySQL')}`);
console.log(gris('─'.repeat(52)));

openDatabase(config.dbFile);
const source = getDb();
console.log(`  source : ${config.dbFile}`);

openMysql(config.mysql);
const info = mysqlInfo();
console.log(`  cible  : ${info.user}@${info.host}:${info.port}/${gras(info.database)}\n`);

// Le schéma doit exister avant d'y verser quoi que ce soit.
const m = await migrateMysql({ prepare, exec });
if (m.applied.length) console.log(`  ${vert('✓')} schéma créé (migrations ${m.applied.join(', ')})\n`);

// ── Ce qu'il y a à transférer, et ce qu'il y a déjà ──
let total = 0;
const plan = [];
for (const t of TABLES) {
  const n = source.prepare(`SELECT COUNT(*) n FROM ${t.nom}`).get().n;
  const dejaLa = Number((await prepare(`SELECT COUNT(*) n FROM \`${t.nom}\``).get()).n);
  plan.push({ ...t, n, dejaLa });
  total += n;
  const marque = dejaLa ? orange(`${nombre(dejaLa)} déjà présente(s)`) : gris('vide');
  console.log(`  ${t.nom.padEnd(18)} ${String(nombre(n)).padStart(8)} ligne(s)   ${marque}`);
}
console.log(`\n  ${gras(nombre(total))} ligne(s) au total`);

const occupees = plan.filter((t) => t.dejaLa);
if (occupees.length && !options.force) {
  console.log(`\n  ${orange('La cible n’est pas vide.')} Ajoutez ${gras('--force')} pour la vider d’abord,`);
  console.log(`  ou videz-la vous-même. Rien n’a été transféré.`);
  closeDatabase();
  await closeMysql();
  process.exit(1);
}

if (!options.yes) {
  console.log(`\n  ${orange('Rien n’a été écrit.')} Ajoutez ${gras('--yes')} pour transférer.`);
  closeDatabase();
  await closeMysql();
  process.exit(0);
}

// ── Le transfert ──
console.log();
if (options.force) {
  await exec('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of [...TABLES].reverse()) await exec(`DELETE FROM \`${t.nom}\``);
  await exec('SET FOREIGN_KEY_CHECKS = 1');
  console.log(`  ${gris('tables de destination vidées')}\n`);
}

const t0 = Date.now();
let transferees = 0;
for (const t of plan) {
  if (!t.n) { console.log(`  ${gris('·')} ${t.nom.padEnd(18)} ${gris('rien à transférer')}`); continue; }

  const lignes = source.prepare(`SELECT ${t.cols.map((x) => `"${x}"`).join(', ')} FROM ${t.nom}`).all();
  const limites = LIMITES[t.nom] ?? {};
  const valeurs = lignes.map((l) => t.cols.map((col) => {
    const v = l[col];
    return limites[col] ? borner(v, limites[col]) : v;
  }));

  const debut = Date.now();
  const n = await insertMany(t.nom, t.cols, valeurs, { chunk: 500 });
  transferees += lignes.length;
  console.log(`  ${vert('✓')} ${t.nom.padEnd(18)} ${String(nombre(lignes.length)).padStart(8)} ligne(s)   ${gris(`${((Date.now() - debut) / 1000).toFixed(1)} s`)}`);
  void n;
}

// ── Le contrôle : les comptes doivent correspondre, des deux côtés ──
console.log(`\n${gras('Contrôle')}`);
let ecarts = 0;
for (const t of plan) {
  const avant = t.n;
  const apres = Number((await prepare(`SELECT COUNT(*) n FROM \`${t.nom}\``).get()).n);
  if (avant !== apres) {
    ecarts += 1;
    console.log(`  ${rouge('✗')} ${t.nom.padEnd(18)} ${nombre(avant)} à la source, ${nombre(apres)} à l’arrivée`);
  }
}
if (!ecarts) console.log(`  ${vert('✓')} toutes les tables ont le même nombre de lignes des deux côtés`);

console.log(`\n  ${nombre(transferees)} ligne(s) transférée(s) en ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log(gris(`  La base SQLite n’a pas été modifiée : ${config.dbFile}`));

closeDatabase();
await closeMysql();
process.exit(ecarts ? 1 : 0);

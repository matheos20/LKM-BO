/**
 * Accès à MySQL / MariaDB.
 *
 * Le dépôt venait de SQLite, dont le pilote est SYNCHRONE : on écrivait
 * `db.prepare(sql).get(...)` et la valeur revenait aussitôt. Aucun pilote MySQL ne
 * fonctionne ainsi, et c'est le vrai coût de cette migration : tout ce qui interroge la
 * base devient asynchrone, et l'attente remonte jusqu'aux routes.
 *
 * La forme des appels est conservée — `prepare(sql).get()`, `.all()`, `.run()` — pour
 * que la relecture du code reste possible et que la conversion se fasse requête par
 * requête, sans tout réécrire d'un coup. Seul `await` s'ajoute devant.
 *
 * Les requêtes passent toutes par des paramètres liés : une valeur n'est jamais collée
 * dans le texte SQL, et une injection n'a pas de prise.
 */
import mysql from 'mysql2/promise';

let pool = null;
let reglages = null;

/**
 * Ouvre le groupe de connexions.
 *
 * Un POOL plutôt qu'une connexion unique : l'application sert plusieurs agents à la
 * fois, et une opération de masse interroge la base pendant qu'un autre écran la lit.
 * Une connexion unique les mettrait en file d'attente.
 */
export function openMysql(config) {
  if (pool) return pool;
  reglages = {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectionLimit: config.connectionLimit ?? 10,
    charset: 'utf8mb4_unicode_ci',
    // Les grands entiers en texte plutôt qu'en nombre approché : nos horodatages sont
    // en millisecondes, et au-delà de 2^53 JavaScript arrondit en silence.
    supportBigNumbers: true,
    bigNumberStrings: false,
    dateStrings: true,
    multipleStatements: false,
    namedPlaceholders: false,
  };
  pool = mysql.createPool(reglages);
  return pool;
}

export function getPool() {
  if (!pool) throw new Error('base MySQL non ouverte');
  return pool;
}

export async function closeMysql() {
  if (!pool) return;
  await pool.end();
  pool = null;
}

/** Les réglages en cours, sans le mot de passe : pour les journaux et les diagnostics. */
export const mysqlInfo = () => (reglages ? { host: reglages.host, port: reglages.port, user: reglages.user, database: reglages.database } : null);

/**
 * Une requête préparée, dans la forme du reste du dépôt.
 *
 * `get` rend la première ligne ou `undefined`, `all` le tableau, `run` le résultat
 * d'écriture avec le nombre de lignes touchées et l'identifiant créé. Les trois sont
 * asynchrones : `await db.prepare(sql).get(id)`.
 */
export function prepare(sql) {
  const texte = String(sql);
  const executer = async (args) => {
    const [lignes] = await getPool().execute(texte, args.map((v) => (v === undefined ? null : v)));
    return lignes;
  };
  return {
    sql: texte,
    async get(...args) {
      const lignes = await executer(args);
      return Array.isArray(lignes) ? lignes[0] : undefined;
    },
    async all(...args) {
      const lignes = await executer(args);
      return Array.isArray(lignes) ? lignes : [];
    },
    async run(...args) {
      const r = await executer(args);
      return { changes: r.affectedRows ?? 0, lastInsertRowid: r.insertId ?? 0 };
    },
  };
}

/** Plusieurs ordres SQL d'affilée. Sert aux migrations, jamais aux données d'un agent. */
export async function exec(sql) {
  const ordres = String(sql)
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const ordre of ordres) await getPool().query(ordre);
}

/**
 * Exécute une fonction dans une transaction, sur UNE connexion réservée.
 *
 * Le point important : la fonction reçoit cette connexion et doit s'en servir. Lancer
 * une requête sur le pool à l'intérieur d'une transaction l'enverrait sur une AUTRE
 * connexion, hors de la transaction — et un échec ne la défolderait pas.
 */
export async function transaction(fn) {
  const cnx = await getPool().getConnection();
  const lie = {
    prepare(sql) {
      const texte = String(sql);
      const executer = async (args) => {
        const [lignes] = await cnx.execute(texte, args.map((v) => (v === undefined ? null : v)));
        return lignes;
      };
      return {
        async get(...args) { const l = await executer(args); return Array.isArray(l) ? l[0] : undefined; },
        async all(...args) { const l = await executer(args); return Array.isArray(l) ? l : []; },
        async run(...args) { const r = await executer(args); return { changes: r.affectedRows ?? 0, lastInsertRowid: r.insertId ?? 0 }; },
      };
    },
    query: (sql, args = []) => cnx.query(sql, args),
  };
  try {
    await cnx.beginTransaction();
    const out = await fn(lie);
    await cnx.commit();
    return out;
  } catch (err) {
    await cnx.rollback();
    throw err;
  } finally {
    cnx.release();
  }
}

/**
 * Insère un grand nombre de lignes en un minimum d'allers-retours.
 *
 * L'import Cloudflare écrit 38 000 lignes : une requête par ligne tiendrait des
 * minutes. On les groupe par paquets, en restant loin de la taille maximale d'un
 * paquet MySQL.
 */
export async function insertMany(table, colonnes, lignes, { chunk = 500, onDuplicate = '' } = {}) {
  if (!lignes.length) return 0;
  const noms = colonnes.map((c) => `\`${c}\``).join(', ');
  const trou = `(${colonnes.map(() => '?').join(', ')})`;
  let total = 0;
  for (let i = 0; i < lignes.length; i += chunk) {
    const lot = lignes.slice(i, i + chunk);
    const sql = `INSERT INTO \`${table}\` (${noms}) VALUES ${lot.map(() => trou).join(', ')}${onDuplicate ? ` ON DUPLICATE KEY UPDATE ${onDuplicate}` : ''}`;
    const [r] = await getPool().query(sql, lot.flat().map((v) => (v === undefined ? null : v)));
    total += r.affectedRows ?? 0;
  }
  return total;
}

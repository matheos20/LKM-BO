import mysql from 'mysql2/promise';
import { PERMISSION_KEYS, SYSTEM_ROLES } from '../src/auth/permissions.js';
import { config } from '../src/config.js';
import { closeMysql, exec, openMysql, prepare } from '../src/db/mysql.js';
import { migrateMysql, seedSystemRolesMysql } from '../src/db/mysqlSchema.js';

/**
 * Une base MySQL jetable pour les contrôles.
 *
 * Trois règles tiennent ce fichier :
 *
 *   - JAMAIS la base de l'application. Chaque suite travaille sur la sienne, nommée
 *     d'après elle, créée au début et supprimée à la fin. Un contrôle qui laisse des
 *     traces fait échouer le suivant pour une raison qu'on cherchera longtemps.
 *   - CHAQUE SUITE SA BASE. Les fichiers de test tournent dans des processus séparés,
 *     parfois en même temps : deux suites sur une même base se marcheraient dessus.
 *   - SANS SERVEUR, ON LE DIT. Sur une machine sans MySQL — une autre installation, un
 *     serveur d'intégration — les contrôles s'annoncent ignorés plutôt que de faire
 *     échouer la suite entière. Un contrôle qu'on ne peut pas exécuter ne doit mentir
 *     dans aucun sens.
 *
 * Usage :
 *
 *     const base = creerBaseJetable('audit');
 *     before(() => base.ouvrir());
 *     after(() => base.fermer());
 *     test('…', async (t) => { if (!base.prete) return t.skip(base.motif); … });
 */
export function creerBaseJetable(nom) {
  const nomBase = `${config.mysql.database}_test_${nom}`;
  const etat = { prete: false, motif: '', nomBase };

  return {
    get prete() { return etat.prete; },
    get motif() { return etat.motif; },
    get nomBase() { return nomBase; },

    async ouvrir({ seedRoles = true } = {}) {
      try {
        const cnx = await mysql.createConnection({
          host: config.mysql.host,
          port: config.mysql.port,
          user: config.mysql.user,
          password: config.mysql.password,
          connectTimeout: 3000,
        });
        await cnx.query(`DROP DATABASE IF EXISTS \`${nomBase}\``);
        await cnx.query(`CREATE DATABASE \`${nomBase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        await cnx.end();

        openMysql({ ...config.mysql, database: nomBase });
        await migrateMysql({ prepare, exec });
        if (seedRoles) await seedSystemRolesMysql(null, { SYSTEM_ROLES, PERMISSION_KEYS });
        etat.prete = true;
      } catch (err) {
        etat.motif = `MySQL injoignable (${String(err.message).slice(0, 60)})`;
      }
      return etat.prete;
    },

    async fermer() {
      if (!etat.prete) return;
      await exec(`DROP DATABASE IF EXISTS \`${nomBase}\``);
      await closeMysql();
    },

    /** Vide les tables nommées, dans l'ordre donné. Pour repartir d'un état connu. */
    async vider(...tables) {
      if (!etat.prete) return;
      await exec('SET FOREIGN_KEY_CHECKS = 0');
      for (const t of tables) await exec(`DELETE FROM \`${t}\``);
      await exec('SET FOREIGN_KEY_CHECKS = 1');
    },
  };
}

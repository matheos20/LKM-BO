import { backupDatabase, listDbBackups, verifyBackup } from './dbBackup.js';
import { prepare } from '../db/mysql.js';

/**
 * La sauvegarde automatique.
 *
 * `npm run backup` existait, et personne ne le lançait. Une sauvegarde qu'il faut penser
 * à faire n'est pas une sauvegarde.
 *
 * ON NE PLANIFIE PAS « TOUTES LES 24 HEURES », ON RATTRAPE LE RETARD. Un minuteur de
 * vingt-quatre heures posé au démarrage ne se déclencherait jamais sur une machine qu'on
 * éteint le soir, ou qu'un surveillant relance : le compte repartirait de zéro à chaque
 * fois. On regarde donc l'âge de la DERNIÈRE sauvegarde, et on en fait une si elle est
 * trop vieille. Une machine éteinte tout un week-end est sauvegardée en revenant.
 *
 * Cet âge se lit dans le dossier lui-même — les fichiers portent leur horodatage dans
 * leur nom. Rien à mémoriser ailleurs, rien à désynchroniser.
 *
 * ET ON RESTAURE POUR DE BON, RÉGULIÈREMENT. Une sauvegarde jamais rejouée est un
 * fichier dont on espère quelque chose. Le contrôle la restaure dans une base jetable et
 * compare — le jour où on en a besoin est le pire moment pour découvrir qu'elle ne vaut
 * rien. La date du dernier contrôle réussi se lit dans le journal d'audit : c'est là
 * qu'elle intéresse l'agent, et il n'y a pas de second endroit à tenir à jour.
 */

/** Entre deux examens. Court : l'examen ne fait que lire un dossier. */
const PAS_MS = 15 * 60_000;
/** Au démarrage, on laisse l'application se mettre en place avant de l'occuper. */
const DELAI_DEMARRAGE_MS = 20_000;

/** Journalise au nom de l'application : l'auteur n'est personne, et ça doit se voir. */
const systeme = (audit, entree) => audit({ ip: null, user: null }, { user: 'système', ...entree });

/** Âge de la sauvegarde la plus récente, en heures. `Infinity` s'il n'y en a aucune. */
export function ageDerniereSauvegarde(dir, maintenant = Date.now()) {
  const derniere = listDbBackups(dir)[0];
  return derniere ? (maintenant - derniere.at) / 3_600_000 : Infinity;
}

/**
 * Date du dernier contrôle de restauration RÉUSSI.
 *
 * Elle vit dans le journal, ce qui la fait survivre à un redémarrage et la met sous les
 * yeux de l'agent — pas de second endroit à tenir à jour.
 *
 * MAIS LE JOURNAL S'ÉCRIT SANS QU'ON L'ATTENDE : journaliser ne doit jamais retarder ce
 * qu'on journalise. Relire tout de suite peut donc rendre une valeur périmée, et faire
 * refaire un contrôle qui vient d'avoir lieu. La dernière date connue est gardée en
 * mémoire, et c'est la plus récente des deux qui fait foi : la mémoire couvre le
 * processus en cours, le journal couvre les redémarrages.
 */
async function dernierControle(enMemoire) {
  let enBase = 0;
  try {
    const l = await prepare("SELECT MAX(at) AS at FROM audit_events WHERE action = 'backup.verify' AND ok = 1").get();
    enBase = l?.at ? Number(l.at) : 0;
  } catch {
    // Journal illisible : on ne bloque pas la sauvegarde pour autant.
  }
  return Math.max(enBase, enMemoire ?? 0);
}

/**
 * Décide ce qu'il y a à faire, sans rien faire.
 *
 * Séparé pour être vérifiable sans base ni fichiers : c'est ici que vit la règle, et
 * c'est elle qu'on veut contrôler.
 */
export function aFaire({ ageHeures, controleIlYaJours, everyHours, verifyEveryDays }) {
  return {
    sauvegarder: ageHeures >= everyHours,
    verifier: verifyEveryDays > 0 && controleIlYaJours >= verifyEveryDays,
  };
}

/**
 * Met en route la sauvegarde automatique.
 * @returns {{ stop: () => void, tick: () => Promise<object> }}
 */
export function startBackupSchedule({ config, audit, log = console }) {
  const reglages = config.backup;
  if (!reglages.auto) {
    log.log('[sauvegarde] automatique désactivée (BACKUP_AUTO=false)');
    return { stop: () => {}, tick: async () => ({ skipped: 'désactivée' }) };
  }

  let enCours = false;
  // Le dernier controle reussi, vu par CE processus : voir dernierControle().
  let controleEnMemoire = 0;

  async function tick() {
    // Jamais deux à la fois : un examen qui tombe pendant une vérification de cinq
    // secondes en lancerait une seconde, et les deux se disputeraient la base jetable.
    if (enCours) return { skipped: 'déjà en cours' };
    enCours = true;
    const fait = { backup: null, verify: null };
    try {
      const age = ageDerniereSauvegarde(reglages.dir);
      const controle = await dernierControle(controleEnMemoire);
      const quoi = aFaire({
        ageHeures: age,
        controleIlYaJours: controle ? (Date.now() - controle) / 86_400_000 : Infinity,
        everyHours: reglages.everyHours,
        verifyEveryDays: reglages.verifyEveryDays,
      });

      if (quoi.sauvegarder) {
        try {
          const r = backupDatabase({ dir: reglages.dir, mysql: config.mysql, keep: reglages.keep, secret: reglages.secret, mysqldump: reglages.mysqldump });
          fait.backup = r;
          log.log(`[sauvegarde] ${r.name} — ${(r.bytes / 1048576).toFixed(1)} Mo en ${(r.ms / 1000).toFixed(1)} s${r.removed.length ? `, ${r.removed.length} ancienne(s) effacée(s)` : ''}`);
          systeme(audit, { action: 'backup.create', target: `${r.name} · ${(r.bytes / 1048576).toFixed(1)} Mo`, ok: true });
        } catch (err) {
          // UNE SAUVEGARDE QUI ÉCHOUE DOIT SE VOIR. Elle entre au journal comme un
          // échec : c'est le seul endroit où l'agent la retrouvera, et c'est l'écran
          // qu'il consulte. La console, elle, aura disparu au prochain redémarrage.
          log.error(`[sauvegarde] ÉCHEC : ${err.message}`);
          systeme(audit, { action: 'backup.create', target: 'automatique', ok: false, error: err.message });
        }
      }

      if (quoi.verifier) {
        try {
          const r = await verifyBackup({ dir: reglages.dir, mysql: config.mysql, secret: reglages.secret, mysqlClient: reglages.mysqlClient });
          fait.verify = r;
          // Meme rate, le controle ne se refait pas dans la minute : il faudrait corriger
          // la cause d'abord, et le rejouer en boucle ne ferait que remplir le journal.
          controleEnMemoire = Date.now();
          const resume = `${r.backup} · ${r.tables.length} table(s)`;
          if (r.ok) log.log(`[sauvegarde] contrôle de restauration réussi — ${resume} en ${(r.ms / 1000).toFixed(1)} s`);
          else log.error(`[sauvegarde] CONTRÔLE DE RESTAURATION EN ÉCHEC — ${r.problems.join(' ; ')}`);
          systeme(audit, { action: 'backup.verify', target: resume, ok: r.ok, error: r.ok ? null : r.problems.join(' ; ').slice(0, 280) });
        } catch (err) {
          log.error(`[sauvegarde] contrôle de restauration impossible : ${err.message}`);
          systeme(audit, { action: 'backup.verify', target: 'automatique', ok: false, error: err.message });
        }
      }
      return fait;
    } finally {
      enCours = false;
    }
  }

  // Au démarrage puis régulièrement. `unref` : ce minuteur ne doit jamais empêcher le
  // processus de se terminer quand on lui demande de s'arrêter.
  const premier = setTimeout(() => { tick().catch(() => {}); }, DELAI_DEMARRAGE_MS);
  const suite = setInterval(() => { tick().catch(() => {}); }, PAS_MS);
  premier.unref();
  suite.unref();

  log.log(`[sauvegarde] automatique : toutes les ${reglages.everyHours} h, contrôle de restauration tous les ${reglages.verifyEveryDays} jour(s)`);
  return {
    stop: () => { clearTimeout(premier); clearInterval(suite); },
    tick,
  };
}

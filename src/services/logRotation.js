import fs from 'node:fs';
import path from 'node:path';

/**
 * Rotation d'un journal en fichier.
 *
 * `logs/audit.log` grossissait sans fin. Un journal qui remplit le disque fait tomber ce
 * qu'il observe — et c'est la panne la plus bête qui soit, puisqu'elle vient de l'outil
 * censé aider à comprendre les autres.
 *
 * LA TAILLE EST SUIVIE EN MÉMOIRE, pas relue à chaque ligne. Une interrogation du
 * système de fichiers par événement coûterait plus cher que l'écriture elle-même, pour
 * une information qu'on connaît déjà : on sait ce qu'on vient d'écrire. La taille de
 * départ est lue une fois, à l'ouverture.
 *
 * LES ANCIENNES GÉNÉRATIONS DÉCALENT : audit.log → .1 → .2 … et la dernière disparaît.
 * On garde donc toujours la même quantité de passé, quelle que soit l'activité.
 */

/** Taille et nombre de générations par défaut : cinq fois cinq mégaoctets. */
export const MAX_OCTETS = 5 * 1024 * 1024;
export const GENERATIONS = 5;

/**
 * Faut-il faire tourner le journal avant d'écrire `aEcrire` octets ?
 *
 * On tourne AVANT d'écrire, et non après : une ligne ne doit jamais se retrouver coupée
 * entre deux fichiers. La conséquence est qu'un fichier peut rester légèrement sous la
 * limite plutôt que de la dépasser, ce qui est le bon côté pour se tromper.
 */
export const doitTourner = (taille, aEcrire, max = MAX_OCTETS) => taille > 0 && taille + aEcrire > max;

/**
 * Décale les générations : .4 → .5, .3 → .4, … et le journal devient .1.
 *
 * On part de la plus ancienne, sinon chaque renommage écraserait le suivant. La dernière
 * génération n'est pas renommée : elle est simplement recouverte, et disparaît.
 */
export function tourner(fichier, generations = GENERATIONS) {
  for (let i = generations - 1; i >= 1; i -= 1) {
    const de = `${fichier}.${i}`;
    if (fs.existsSync(de)) fs.renameSync(de, `${fichier}.${i + 1}`);
  }
  if (fs.existsSync(fichier)) fs.renameSync(fichier, `${fichier}.1`);
}

/**
 * Un écrivain de journal qui fait tourner le fichier tout seul.
 *
 * @returns {{ write(texte: string): void, size(): number }}
 */
export function createRotatingLog(fichier, { max = MAX_OCTETS, keep = GENERATIONS } = {}) {
  fs.mkdirSync(path.dirname(fichier), { recursive: true });
  let taille = 0;
  try {
    taille = fs.statSync(fichier).size;
  } catch {
    // Le journal n'existe pas encore : il partira de zéro.
  }

  return {
    write(texte) {
      const octets = Buffer.byteLength(texte);
      try {
        if (doitTourner(taille, octets, max)) {
          tourner(fichier, keep);
          taille = 0;
        }
        // ÉCRITURE SYNCHRONE, ET C'EST VOULU.
        //
        // L'écriture différée paraissait plus prudente — ne pas retarder ce qu'on
        // journalise — mais elle rendait la rotation fausse : le renommage arrivait
        // pendant que des lignes étaient encore en vol. Sous Windows, renommer un
        // fichier ainsi ouvert échoue (EPERM) ; ailleurs, les lignes atterrissent dans
        // le fichier déjà mis de côté. On a mesuré un journal à 2 000 octets pour une
        // limite de 1 000.
        //
        // Écrire sur place rend rotation et écriture strictement ordonnées. Le coût est
        // une poignée de microsecondes par événement, à comparer au demi-seconde d'un
        // aller-retour SSH que cette même action vient de payer.
        fs.appendFileSync(fichier, texte);
        taille += octets;
      } catch (err) {
        // Ne JAMAIS faire tomber l'application pour un problème de journal.
        console.error(`[audit] journal : ${err.message}`);
      }
    },
    size: () => taille,
  };
}

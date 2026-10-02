import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_OCTETS, createRotatingLog, doitTourner, tourner } from '../src/services/logRotation.js';
import { createAudit } from '../src/services/audit.js';

/**
 * La rotation du journal en fichier.
 *
 * `logs/audit.log` grossissait sans fin. Un journal qui remplit le disque fait tomber ce
 * qu'il observe — la panne la plus bête qui soit, puisqu'elle vient de l'outil censé
 * aider à comprendre les autres.
 */
async function dansUnDossier(fn) {
  const d = mkdtempSync(join(tmpdir(), 'lkm-journal-'));
  try {
    // « await » et non « return » : sans lui, le dossier serait effacé pendant que le
    // corps asynchrone travaille encore, et les contrôles liraient le vide.
    return await fn(d);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

/** L'ecriture est synchrone : il n'y a plus rien a attendre, on garde la forme. */
const attendre = async () => {};

test('journal : on tourne AVANT d’écrire, jamais au milieu d’une ligne', () => {
  // Tourner après coup couperait une ligne entre deux fichiers, et un journal qu'on ne
  // peut plus relire ligne à ligne n'est plus exploitable par aucun outil.
  assert.equal(doitTourner(0, 100, 1000), false, 'un fichier vide ne tourne jamais');
  assert.equal(doitTourner(900, 50, 1000), false, 'ça tient encore');
  assert.equal(doitTourner(900, 101, 1000), true, 'ça ne tiendrait plus : on tourne d’abord');
  assert.equal(doitTourner(1000, 1, 1000), true);
  // Conséquence voulue : un fichier reste légèrement SOUS la limite plutôt que de la
  // dépasser. C'est le bon côté pour se tromper.
  assert.equal(doitTourner(999, 1, 1000), false);
});

test('journal : les générations décalent, la plus ancienne disparaît', async () => {
  await dansUnDossier((d) => {
    const f = join(d, 'audit.log');
    for (const [nom, contenu] of [[f, 'courant'], [`${f}.1`, 'un'], [`${f}.2`, 'deux'], [`${f}.3`, 'trois']]) {
      writeFileSync(nom, contenu);
    }
    tourner(f, 3);

    // On part de la PLUS ANCIENNE, sinon chaque renommage écraserait le suivant.
    assert.equal(existsSync(f), false, 'le journal a laissé la place');
    assert.equal(readFileSync(`${f}.1`, 'utf8'), 'courant');
    assert.equal(readFileSync(`${f}.2`, 'utf8'), 'un');
    assert.equal(readFileSync(`${f}.3`, 'utf8'), 'deux');
    // « trois » était la dernière génération gardée : elle est recouverte, donc perdue.
    assert.equal(existsSync(`${f}.4`), false, 'on ne garde pas plus que ce qui est demandé');
  });
});

test('journal : tourner un fichier qui n’existe pas ne lève pas', async () => {
  await dansUnDossier((d) => {
    assert.doesNotThrow(() => tourner(join(d, 'jamais-ecrit.log'), 5));
  });
});

test('journal : il tourne tout seul, et garde la quantité demandée', async () => {
  await dansUnDossier(async (d) => {
    const f = join(d, 'audit.log');
    const ligne = `${'x'.repeat(199)}\n`; // 200 octets
    const journal = createRotatingLog(f, { max: 1000, keep: 3 });

    for (let i = 0; i < 25; i += 1) journal.write(ligne);
    await attendre();

    // 25 lignes de 200 octets = 5 000 octets, pour une limite de 1 000 : il a tourné.
    assert.ok(statSync(f).size <= 1000, `le journal courant reste sous la limite (${statSync(f).size})`);
    assert.ok(existsSync(`${f}.1`), 'une génération précédente existe');
    assert.ok(existsSync(`${f}.3`), 'et la troisième aussi');
    assert.equal(existsSync(`${f}.4`), false, 'mais pas au-delà : le disque ne se remplit plus');
  });
});

test('journal : la taille est suivie en MÉMOIRE, pas relue à chaque ligne', async () => {
  await dansUnDossier(async (d) => {
    // Une interrogation du système de fichiers par événement coûterait plus cher que
    // l'écriture elle-même, pour une information qu'on connaît déjà.
    const f = join(d, 'audit.log');
    const journal = createRotatingLog(f, { max: 10_000, keep: 3 });
    assert.equal(journal.size(), 0);
    journal.write('abcde\n'); // 6 octets
    assert.equal(journal.size(), 6, 'comptée tout de suite, sans attendre l’écriture');
    journal.write('fg\n');
    assert.equal(journal.size(), 9);
    await attendre();
    assert.equal(statSync(f).size, 9, 'et le fichier dit la même chose');
  });
});

test('journal : il reprend la taille du fichier existant à l’ouverture', async () => {
  await dansUnDossier(async (d) => {
    // Sans cela, un redémarrage repartirait de zéro et le fichier doublerait avant de
    // tourner — à chaque redémarrage.
    const f = join(d, 'audit.log');
    writeFileSync(f, 'x'.repeat(900));
    const journal = createRotatingLog(f, { max: 1000, keep: 3 });
    assert.equal(journal.size(), 900, 'la taille de départ est lue une fois');

    journal.write(`${'y'.repeat(199)}\n`);
    await attendre();
    assert.ok(existsSync(`${f}.1`), 'la ligne de trop a fait tourner, pas débordé');
    assert.equal(readFileSync(`${f}.1`, 'utf8').length, 900);
  });
});

test('journal : un problème d’écriture ne fait pas tomber l’application', async () => {
  await dansUnDossier((d) => {
    // Journaliser ne doit JAMAIS casser ce qu'on journalise. Ici le chemin désigne un
    // dossier : l'écriture est impossible, et pourtant rien ne lève.
    const journal = createRotatingLog(join(d, 'sous', 'audit.log'), { max: 100, keep: 2 });
    assert.doesNotThrow(() => journal.write('une ligne\n'));
  });
});

test('journal : l’audit écrit bien dans le fichier qui tourne', async () => {
  await dansUnDossier(async (d) => {
    const f = join(d, 'audit.log');
    const audit = createAudit(f, { maxBytes: 600, keep: 2 });
    const faux = { ip: '127.0.0.1', user: null };
    for (let i = 0; i < 12; i += 1) audit(faux, { action: 'essai.rotation', target: `cible ${i}`, ok: true, user: 'système' });
    await attendre();

    assert.ok(existsSync(`${f}.1`), 'le journal d’audit a tourné');
    // Et ce qu'il écrit reste du JSON Lines, relisible ligne à ligne.
    const lignes = readFileSync(f, 'utf8').trim().split('\n').filter(Boolean);
    assert.ok(lignes.length > 0);
    for (const l of lignes) {
      const o = JSON.parse(l);
      assert.equal(o.action, 'essai.rotation');
      assert.equal(o.user, 'système');
      assert.ok(o.ts, 'chaque ligne est horodatée');
    }
  });
});

test('journal : les valeurs par défaut sont raisonnables', () => {
  // Cinq fois cinq mégaoctets : assez pour remonter loin, trop peu pour remplir un disque.
  assert.equal(MAX_OCTETS, 5 * 1024 * 1024);
});

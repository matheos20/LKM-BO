import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * LE RETOUR EN ARRIÈRE APRÈS UNE CRÉATION DE RUBRIQUE.
 *
 * L'écran savait créer et savait supprimer, mais n'offrait pas de RETOUR : une rubrique
 * qui ne convenait pas obligeait l'agent à changer de verbe, retaper le domaine et le
 * nom, et relancer — en espérant ne pas se tromper de rubrique au passage.
 *
 * Ce que ces essais tiennent, c'est la promesse du bouton : il défait CE QUI VIENT
 * D'ÊTRE POSÉ, et rien d'autre. Une rubrique qui existait avant la création n'y figure
 * pas et ne peut donc pas être emportée. Le reste — la page qui part, l'article qui
 * reste — est éprouvé sur du vrai PHP dans `categories.test.js`.
 */
const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const ECRAN = readFileSync(join(RACINE, 'public/js/categories.js'), 'utf8');
const LANGUES = ['fr', 'en', 'es', 'it', 'pt', 'de'];
const locale = (l) => JSON.parse(readFileSync(join(RACINE, `locales/${l}.json`), 'utf8'));

/** Le corps d'une fonction du module, pour l'examiner de près. */
function corps(nom) {
  const debut = ECRAN.indexOf(`function ${nom}(`);
  assert.ok(debut >= 0, `« ${nom} » doit exister`);
  const suite = ECRAN.slice(debut);
  const fin = suite.indexOf('\n}\n');
  return suite.slice(0, fin > 0 ? fin : 2500);
}

// ─────────────────────────── ce qui est retenu ───────────────────────────

test('rubriques : SEULES les rubriques réellement posées sont annulables', () => {
  // `done` est rempli par le serveur pour chaque pièce effectivement écrite. Une
  // rubrique déjà en place revient avec `done` vide : elle n'entre pas dans la liste,
  // et le retour en arrière ne la touchera jamais.
  const creation = corps('creer');
  assert.match(creation, /state\.annulables\.set\(/, 'la création retient ce qu’elle a posé');
  assert.match(creation, /res\.items\.filter\(\(it\) => it\.done\.length\)\.map\(/, 'et seulement ce qui a « done »');
  assert.match(creation, /state\.operation === 'add'/, 'une suppression ne se retient pas comme annulable');
  assert.match(creation, /else state\.annulables\.delete\(/, 'un site où rien n’a été posé n’est pas annulable');
});

test('rubriques : une nouvelle vérification efface le retour en arrière', () => {
  // Garder une liste périmée proposerait de défaire quelque chose qui n'est plus à
  // l'écran — et le clic porterait alors sur des rubriques que l'agent ne voit pas.
  const reset = ECRAN.slice(ECRAN.indexOf('  reset() {'), ECRAN.indexOf('  reset() {') + 600);
  assert.match(reset, /state\.annulables\.clear\(\)/);
  assert.match(reset, /state\.done\.clear\(\)/);
});

test('rubriques : le retour en arrière envoie l’opération « remove », jamais autre chose', () => {
  const annul = corps('annuler');
  assert.match(annul, /operation: 'remove'/, 'c’est bien une suppression côté serveur');
  assert.ok(!/state\.operation/.test(annul), 'et elle ne dépend PAS du verbe affiché à l’écran');
  // Les rubriques envoyées sont celles retenues, pas celles du tableau en cours : le
  // tableau peut avoir été recalculé entre-temps.
  assert.match(annul, /state\.annulables\.get\(cle\)/);
  assert.match(annul, /request\[lot\.domain\] = lot\.items/);
});

test('rubriques : une fois défait, plus rien ne propose de le défaire', () => {
  const annul = corps('annuler');
  assert.match(annul, /state\.annulables\.delete\(cle\)/);
  assert.match(annul, /state\.done\.delete\(cle\)/, 'la pastille « fait » s’en va aussi');
  // Le tableau du site est remplacé par ce que le serveur vient de rendre : laisser
  // l'ancien afficherait une rubrique présente alors qu'elle ne l'est plus.
  assert.match(annul, /site\.items = res\.items/);
});

test('rubriques : le lot se découpe par serveur et par paquets de quarante', () => {
  // La même prudence que la création : un lot qui partirait entier ferait une requête
  // de plusieurs centaines de sites.
  const annul = corps('annuler');
  assert.match(annul, /parServeur/);
  assert.match(annul, /i \+= 40/);
});

// ─────────────────────────── ce que l’agent voit ───────────────────────────

test('rubriques : le bouton n’apparaît QUE là où il y a quelque chose à défaire', () => {
  const bouton = corps('boutonRestaurer');
  assert.match(bouton, /state\.annulables\.get\(keyOf\(site\)\)/);
  assert.match(bouton, /if \(!lot\) return null/, 'sinon, pas de bouton du tout');
  // Sombre et non rouge : ce n'est pas une suppression, c'est un retour à l'état
  // d'avant. Le rouge reste au verbe « Supprimer », qui vise ce que l'agent désigne.
  assert.match(bouton, /btn btn-outline/);
  assert.ok(!/btn-danger/.test(bouton), 'le rouge est réservé à la suppression voulue');
  assert.match(bouton, /peutAppliquerEnMasse\(permissions\)/, 'et il demande le droit d’écrire');
});

test('rubriques : défaire plusieurs sites d’un coup, seulement quand il y en a plusieurs', () => {
  const barre = corps('barre');
  assert.match(barre, /aDefaire\.length > 1/, 'un seul site garde son bouton de ligne');
  assert.match(barre, /confirmerAnnulation\(aDefaire\)/);
});

test('rubriques : la confirmation NOMME les rubriques qui vont partir', () => {
  // L'agent doit lire les noms exacts, pas un nombre. Un nombre seul ne permet pas de
  // vérifier qu'on s'apprête à défaire ce qu'on croit.
  const conf = corps('confirmerAnnulation');
  assert.match(conf, /lot\.items\.map\(\(it\) => it\.slug\)\.join/);
  assert.match(conf, /categories\.undo_body/);
  assert.match(conf, /categories\.undo_note/);
  // Et le sort des articles, quand il y en a : le serveur garde le dossier s'il reste
  // quelque chose dedans, et l'agent doit le savoir AVANT, pas après.
  assert.match(conf, /categories\.undo_articles/);
  assert.match(conf, /it\.articles \?\? 0/);
});

test('rubriques : les articles comptés sont ceux des rubriques CONCERNÉES', () => {
  // Compter les articles de tout le site aurait annoncé un chiffre effrayant et faux.
  const conf = corps('confirmerAnnulation');
  assert.match(conf, /new Set\(lot\.items\.map\(\(it\) => it\.slug\)\)/);
  assert.match(conf, /filter\(\(it\) => slugs\.has\(it\.slug\)\)/);
});

// ─────────────────────────── les libellés ───────────────────────────

test('rubriques : le retour en arrière se dit dans les six langues', () => {
  const attendus = ['undo_site', 'undo_all', 'undo_hint', 'undo_title', 'undo_body', 'undo_articles', 'undo_note', 'undo_go', 'undone', 'undo_failed'];
  for (const l of LANGUES) {
    const c = locale(l).categories;
    for (const cle of attendus) {
      assert.equal(typeof c[cle], 'string', `${l} : categories.${cle} manque`);
      assert.ok(c[cle].trim().length > 0, `${l} : categories.${cle} est vide`);
    }
  }
});

test('rubriques : les messages du retour en arrière nomment leurs variables', () => {
  const gabarits = {
    undo_all: ['{count}'],
    undo_body: ['{sites}', '{cats}'],
    undo_articles: ['{count}'],
    undone: ['{count}', '{sites}'],
    undo_failed: ['{count}'],
  };
  for (const l of LANGUES) {
    const c = locale(l).categories;
    for (const [cle, vars] of Object.entries(gabarits)) {
      for (const v of vars) assert.ok(c[cle].includes(v), `${l} : categories.${cle} doit contenir ${v}`);
    }
  }
});

test('rubriques : « restaurer » et « supprimer » ne se disent pas du même mot', () => {
  // Deux boutons voisins qui porteraient le même verbe se confondraient — et l'un
  // vise ce que l'agent désigne, l'autre ce que la machine vient de poser.
  for (const l of LANGUES) {
    const c = locale(l).categories;
    assert.notEqual(c.undo_site.toLowerCase(), c.remove_site.toLowerCase(), `${l} : les deux boutons doivent se lire différemment`);
    assert.notEqual(c.undo_title.toLowerCase(), c.remove_title.toLowerCase(), `${l} : les deux fenêtres aussi`);
  }
});

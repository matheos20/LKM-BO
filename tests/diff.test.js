import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffLines, diffWords, groupHunks, summarize } from '../public/js/diff.js';

const types = (parts) => parts.map((p) => p.type).join(',');

test('deux textes identiques ne signalent aucune différence', () => {
  const lignes = diffLines('a\nb\nc', 'a\nb\nc');
  assert.equal(types(lignes), 'same,same,same');
  assert.deepEqual(summarize(lignes), { added: 0, removed: 0, changed: 0, total: 0 });
});

test('une ligne retouchée est signalée comme retouchée, pas comme une paire jetée/ajoutée', () => {
  const lignes = diffLines('avant\nmilieu\napres', 'avant\nMILIEU\napres');
  assert.equal(types(lignes), 'same,chg,same');
  assert.equal(lignes[1].a, 'milieu');
  assert.equal(lignes[1].b, 'MILIEU');
  assert.deepEqual(summarize(lignes), { added: 0, removed: 0, changed: 1, total: 1 });
});

test('ajouts et suppressions purs restent distincts', () => {
  assert.equal(types(diffLines('a\nc', 'a\nb\nc')), 'same,add,same');
  assert.equal(types(diffLines('a\nb\nc', 'a\nc')), 'same,del,same');
});

test('le cas de la capture : seul le mot modifié est marqué', () => {
  // Le texte réel de 201eat.com, dont la fin seule a changé.
  const avant = "'text' => 'un univers où saveurs et traditions se rencontrent.',";
  const apres = "'text' => 'un univers où saveurs et traditions se rencontrentssss.',";
  const parts = diffWords(avant, apres);

  // Ce qui est commun doit rester commun : on ne surligne pas toute la ligne.
  const commun = parts.filter((p) => p.type === 'same').map((p) => p.text).join('');
  assert.ok(commun.includes('un univers où saveurs et traditions se '), `commun trop court : ${JSON.stringify(commun)}`);

  // Et les deux versions se reconstituent exactement.
  assert.equal(parts.filter((p) => p.type !== 'add').map((p) => p.text).join(''), avant);
  assert.equal(parts.filter((p) => p.type !== 'del').map((p) => p.text).join(''), apres);

  const marque = parts.filter((p) => p.type !== 'same');
  assert.ok(marque.length <= 2, `on attend une seule retouche, pas ${marque.length} : ${JSON.stringify(marque)}`);
});

test('les accents ne coupent pas les mots en deux', () => {
  const parts = diffWords('la mémoire des saveurs', 'la mémoire des saveurs salées');
  assert.equal(parts.filter((p) => p.type === 'del').length, 0);
  assert.equal(parts.filter((p) => p.type !== 'del').map((p) => p.text).join(''), 'la mémoire des saveurs salées');
});

test('un texte vide d’un côté marque tout l’autre côté', () => {
  assert.equal(types(diffLines('', 'a\nb')), 'chg,add');
  assert.equal(types(diffLines('a\nb', '')), 'chg,del');
});

test('les longues plages identiques sont repliées autour de ce qui change', () => {
  const avant = Array.from({ length: 40 }, (_, i) => `ligne ${i}`).join('\n');
  const apres = avant.replace('ligne 20', 'ligne VINGT');
  const blocs = groupHunks(diffLines(avant, apres), 3);

  assert.equal(blocs.map((b) => b.kind).join(','), 'fold,hunk,fold');
  const hunk = blocs.find((b) => b.kind === 'hunk');
  assert.equal(hunk.lines.length, 7, 'la ligne modifiée et trois lignes de contexte de chaque côté');
  assert.ok(hunk.lines.some((l) => l.type === 'chg'));
  // Rien n'est perdu : les blocs couvrent tout le fichier.
  assert.equal(blocs.reduce((t, b) => t + (b.kind === 'hunk' ? b.lines.length : b.count), 0), 40);
});

test('deux textes identiques se replient entièrement', () => {
  const blocs = groupHunks(diffLines('a\nb\nc', 'a\nb\nc'));
  assert.deepEqual(blocs, [{ kind: 'fold', count: 3 }]);
});

test('des changements voisins forment un seul bloc', () => {
  const avant = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
  const apres = avant.replace('l5', 'L5').replace('l7', 'L7');
  const blocs = groupHunks(diffLines(avant, apres), 3);
  assert.equal(blocs.filter((b) => b.kind === 'hunk').length, 1, 'deux retouches à deux lignes d’écart ne font qu’un bloc');
});

test('les lignes gardent leur position d’origine des deux côtés', () => {
  const lignes = diffLines('a\nb\nc\nd', 'a\nX\nc\nd');
  const chg = lignes.find((l) => l.type === 'chg');
  assert.equal(chg.ia, 1);
  assert.equal(chg.ib, 1);
  const dernier = lignes.at(-1);
  assert.equal(dernier.ia, 3);
  assert.equal(dernier.ib, 3);
});

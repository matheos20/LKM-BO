import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BACKUP_KEEP, publishCommand, writeArticleCommand } from '../src/services/siteDriver.js';

const DOC = '/srv/www/exemple.com/public_html';

test('le plafond de conservation est assez haut pour que l’usage normal ne le voie jamais', () => {
  // Mesure du parc au 30/09/2026 : le site le plus travaillé avait six sauvegardes
  // après onze publications dans la même journée.
  assert.ok(BACKUP_KEEP >= 100, `plafond trop bas : ${BACKUP_KEEP}`);
});

test('la publication efface au-delà du plafond, et pas avant', () => {
  const cmd = publishCommand(DOC, { keep: 100 });
  // « tail -n +101 » : les cent premières lignes sont gardées, le reste part.
  assert.ok(cmd.includes('tail -n +101'), cmd);
  assert.ok(!cmd.includes('tail -n +11'), 'l’ancien plafond de dix ne doit plus être là');
});

test('la rotation trie sur le NOM, jamais sur la date du fichier', () => {
  // « cp -a » donne à la copie la date du contenu d'origine : un « ls -t » classerait
  // les sauvegardes par l'âge de ce qu'elles contiennent, et pourrait effacer la plus
  // récente. L'horodatage du nom, lui, ne ment pas.
  for (const cmd of [publishCommand(DOC), writeArticleCommand(DOC, 'rubrique/article.php')]) {
    for (const ligne of cmd.split('\n').filter((l) => l.includes('rm -f') && l.includes('tail'))) {
      assert.ok(!/ls\s+-\w*t/.test(ligne), `tri par date de fichier : ${ligne}`);
      assert.ok(ligne.includes('sort -r'), `tri sur le nom attendu : ${ligne}`);
    }
  }
});

test('un article suit le même plafond que le site', () => {
  const cmd = writeArticleCommand(DOC, 'rubrique/article.php', { keep: 100 });
  assert.ok(cmd.includes('tail -n +101'), cmd);
  assert.ok(!cmd.includes('tail -n +6'), 'l’ancien plafond de cinq ne doit plus être là');
});

test('la sauvegarde précède toujours l’écriture', () => {
  // Si la copie échoue, rien ne doit être écrit : c'est ce qui rend le geste
  // réversible sur un parc en production.
  for (const cmd of [publishCommand(DOC), writeArticleCommand(DOC, 'rubrique/article.php')]) {
    const lignes = cmd.split('\n');
    const copie = lignes.findIndex((l) => l.includes('cp -a'));
    const ecriture = lignes.findIndex((l) => /^cat "\$TMP" >/.test(l.trim()));
    assert.ok(copie >= 0, 'une copie de sauvegarde est attendue');
    assert.ok(ecriture > copie, `l’écriture (${ecriture}) doit suivre la sauvegarde (${copie})`);
  }
});

test('le contrôle de syntaxe PHP garde sa place avant toute écriture', () => {
  for (const cmd of [publishCommand(DOC), writeArticleCommand(DOC, 'rubrique/article.php')]) {
    const lignes = cmd.split('\n');
    const lint = lignes.findIndex((l) => l.includes('php -l'));
    const ecriture = lignes.findIndex((l) => /^cat "\$TMP" >/.test(l.trim()));
    assert.ok(lint >= 0 && lint < ecriture, `php -l doit précéder l’écriture : ${cmd}`);
  }
});

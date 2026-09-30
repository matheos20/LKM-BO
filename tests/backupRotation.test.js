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

/** Position, dans la commande entière, du premier motif donné. */
const ou = (cmd, motif) => cmd.search(motif);

test('la sauvegarde précède toujours l’écriture', () => {
  // Si la copie échoue, rien ne doit être écrit : c'est ce qui rend le geste
  // réversible sur un parc en production. La copie et l'écriture tiennent désormais sur
  // la même ligne, dans le « if » qui ne se déclenche qu'en cas de vrai changement —
  // on compare donc leur position dans le texte, pas leur numéro de ligne.
  for (const cmd of [publishCommand(DOC), writeArticleCommand(DOC, 'rubrique/article.php')]) {
    const copie = ou(cmd, /cp -a "\$DOC\/config\.php"|cp -a "\$F"/);
    const ecriture = ou(cmd, /cat "\$TMP" > "\$DOC\/config\.php"|cat "\$TMP" > "\$F"/);
    assert.ok(copie >= 0, `une copie de sauvegarde est attendue : ${cmd}`);
    assert.ok(ecriture > copie, `l’écriture (${ecriture}) doit suivre la sauvegarde (${copie})`);
  }
});

test('la charte n’est sauvegardée que si elle change, et sur la même ligne que son écriture', () => {
  // Modifier un texte de la page d'accueil créait une sauvegarde « Couleurs » alors que
  // les couleurs n'avaient pas bougé : la copie était inconditionnelle.
  const cmd = publishCommand(DOC, { styleB64: 'Ym9uam91cg==' });
  const ligneStyle = cmd.split('\n').find((l) => l.includes('style-$STAMP.css'));
  assert.ok(ligneStyle, `la sauvegarde de la charte est attendue : ${cmd}`);
  assert.ok(ligneStyle.includes('cmp -s'), `elle doit être conditionnée à une vraie différence : ${ligneStyle}`);
  assert.ok(ligneStyle.indexOf('cp -a') < ligneStyle.indexOf('cat "$BK/.new-style.css" >'), 'la copie avant l’écriture');

  // Sans nouvelle charte, on n'y touche pas du tout.
  assert.ok(!publishCommand(DOC).includes('style-$STAMP.css'), 'aucune sauvegarde de charte si rien n’est envoyé');
});

test('la configuration n’est sauvegardée que si elle change', () => {
  const ligne = publishCommand(DOC).split('\n').find((l) => l.includes('config-$STAMP.php'));
  assert.ok(ligne?.includes('cmp -s'), `la copie doit être conditionnée : ${ligne}`);
});

test('la commande annonce ce qu’elle a réellement touché', () => {
  // Sans cela, l'écran annonce une publication là où rien n'a bougé, et l'agent cherche
  // dans la liste une sauvegarde qui n'existe pas.
  const cmd = publishCommand(DOC, { styleB64: 'Ym9uam91cg==' });
  assert.ok(cmd.includes('echo "LKM-CHANGED:$CHANGES"'), cmd);
  assert.ok(ou(cmd, /LKM-CHANGED/) < ou(cmd, /echo "\$STAMP"/), 'l’horodatage reste la dernière ligne');
});

test('le contrôle de syntaxe PHP garde sa place avant toute écriture', () => {
  for (const cmd of [publishCommand(DOC), writeArticleCommand(DOC, 'rubrique/article.php')]) {
    const lint = ou(cmd, /php -l/);
    const ecriture = ou(cmd, /cat "\$TMP" > "\$DOC\/config\.php"|cat "\$TMP" > "\$F"/);
    assert.ok(lint >= 0 && lint < ecriture, `php -l doit précéder l’écriture : ${cmd}`);
  }
});

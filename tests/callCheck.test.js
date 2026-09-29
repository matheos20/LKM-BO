import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { checkFile, stripLiterals } from '../src/dev/callCheck.js';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const JS_NAVIGATEUR = join(RACINE, 'public/js');

test('aucun module du navigateur n’appelle une fonction ni déclarée ni importée', () => {
  const fautifs = [];
  for (const nom of readdirSync(JS_NAVIGATEUR).filter((f) => f.endsWith('.js')).sort()) {
    for (const { name, count, line } of checkFile(readFileSync(join(JS_NAVIGATEUR, nom), 'utf8'))) {
      fautifs.push(`${nom}:${line} — ${name}() appelé ${count}× : ni déclaré ni importé`);
    }
  }
  assert.deepEqual(fautifs, [], `\n${fautifs.join('\n')}\n`);
});

test('le contrôle voit bien un import manquant', () => {
  // Le cas réel : « fmtSize » était utilisé dans design.js sans figurer à l'import, et
  // l'onglet Sauvegardes restait figé sur « Lecture… » dès qu'un site avait une copie.
  const manquant = checkFile(`import { h } from './ui.js';\nexport const l = (b) => h('td', {}, fmtSize(b.size));\n`);
  assert.deepEqual(manquant.map((x) => x.name), ['fmtSize']);

  const present = checkFile(`import { fmtSize, h } from './ui.js';\nexport const l = (b) => h('td', {}, fmtSize(b.size));\n`);
  assert.deepEqual(present, []);
});

test('les chaînes, gabarits, commentaires et expressions régulières ne sont pas lus comme du code', () => {
  const src = [
    "const a = 'appelBidon(x)';",
    'const b = `texte ${vrai(1)} suite`;',
    '// commentaire avec faux(1)',
    '/* bloc avec autreFaux(2) */',
    'const c = /re(gex)/.test(s);',
  ].join('\n');
  const code = stripLiterals(src);
  assert.ok(!code.includes('appelBidon'), 'une chaîne simple doit être neutralisée');
  assert.ok(!code.includes('faux'), 'les commentaires doivent être neutralisés');
  assert.ok(!code.includes('gex'), 'un littéral d’expression régulière doit être neutralisé');
  // Ce qui est DANS « ${ … } » est du vrai code et doit survivre.
  assert.ok(code.includes('vrai(1)'), 'le code d’un gabarit doit survivre');
  assert.equal(code.length, src.length, 'le nettoyage garde la longueur, donc les numéros de ligne');
});

test('un emoji ne décale pas le nettoyage', () => {
  // « Array.from » découpe par points de code et décalait tout ce qui suit un emoji :
  // « base() » devenait « ase() », et le contrôle inventait des appels.
  const src = "const e = '\u{1f517}';\nconst u = api(`${base()}/x`);\n";
  const code = stripLiterals(src);
  assert.ok(code.includes('base()'), `le code après un emoji doit rester intact : ${JSON.stringify(code)}`);
  assert.deepEqual(checkFile(`import { api, base } from './a.js';\n${src}`), []);
});

test('méthodes abrégées, accesseurs et « const $ » ne passent pas pour des appels', () => {
  const src = [
    "import { t } from './i18n.js';",
    'const $ = (sel) => document.querySelector(sel);',
    'export const vue = {',
    '  stats() { return 1; },',
    '  get cle() { return t("x"); },',
    '};',
    'export const lire = () => $("#a");',
  ].join('\n');
  assert.deepEqual(checkFile(src), []);
});

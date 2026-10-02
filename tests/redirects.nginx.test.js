import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PHP_REDIRECTS } from '../src/services/phpScripts.js';

/**
 * Les redirections 301 sur un parc servi par NGINX.
 *
 * TROIS MESURES ONT CONDUIT À CE MÉCANISME, et chacune a invalidé la précédente :
 *
 *   1. l'ancien bouton écrivait dans `.htaccess`. Les cinq machines du parc tournent
 *      sous nginx, qui ne lit jamais ce fichier : les règles posées n'ont jamais rien
 *      fait, et rien ne le disait à l'agent ;
 *   2. un bloc en tête de `404.php` posait bien l'en-tête « Location », mais le statut
 *      restait 404 — le vhost écrit « error_page 404 /404.php » SANS le signe « = », ce
 *      qui force nginx à garder le code d'erreur. Un navigateur ignore une redirection
 *      sur un 404 ;
 *   3. un fichier `.php` QUI EXISTE est servi comme une page normale, et PHP y impose
 *      son propre code. Vérifié en direct : « HTTP/1.1 301 Moved Permanently ».
 *
 * Ce qui est contrôlé ici, c'est que le script serveur garde ces leçons — et surtout
 * ses garde-fous : ne jamais écraser une vraie page, ne jamais accepter une adresse
 * qu'nginx servirait en clair.
 */
const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');

test('redirections : le mécanisme ne passe plus par .htaccess', () => {
  const service = readFileSync(join(RACINE, 'src/services/redirectService.js'), 'utf8');
  assert.match(service, /PHP_REDIRECTS/, 'le service doit employer le script nginx');
  assert.ok(!/HTACCESS_REDIRECTS/.test(service.split('── ANCIEN')[0]), 'et ne plus appeler l’ancien');
  // La raison doit rester écrite : sans elle, quelqu'un rebranchera le .htaccess.
  assert.match(service, /nginx/i);
});

test('redirections : le fichier posé impose un VRAI 301', () => {
  // L'en-tête seul ne suffit pas : c'est le code 301 qui fait la redirection. Le
  // troisième argument de header() est ce qui l'impose.
  assert.match(PHP_REDIRECTS, /header\('Location: /);
  assert.match(PHP_REDIRECTS, /true, 301/);
  assert.match(PHP_REDIRECTS, /exit;/);
});

test('redirections : SEULES les adresses en « .php » sont acceptées', () => {
  // nginx sert tout autre fichier TEL QUEL : un « /ancienne-page » déposé sans
  // extension s'afficherait en clair, code source compris, au lieu de rediriger.
  assert.match(PHP_REDIRECTS, /substr\(\$chemin, -4\) !== '\.php'/);
  assert.match(PHP_REDIRECTS, /'unsupported'/, 'et l’adresse refusée doit le DIRE');
});

test('redirections : une vraie page n’est JAMAIS écrasée', () => {
  // C'est le garde-fou le plus important : écraser une page en ligne pour y mettre une
  // redirection la ferait disparaître, et la sauvegarde seule ne suffirait pas à ce que
  // l'agent s'en aperçoive.
  assert.match(PHP_REDIRECTS, /\$present && \$stub === null/);
  assert.match(PHP_REDIRECTS, /'exists'/);
  // Nos fichiers se reconnaissent à une marque : sans elle, on ne saurait pas lesquels
  // sont à nous.
  assert.match(PHP_REDIRECTS, /LKM-BO redirection 301/);
  assert.match(PHP_REDIRECTS, /function lireStub/);
});

test('redirections : rien ne sort du dossier du site', () => {
  // Un « ../ » dans l'adresse écrirait ailleurs que dans le site visé.
  assert.match(PHP_REDIRECTS, /\/\.\.\//);
  assert.match(PHP_REDIRECTS, /realpath/, 'le chemin réel est comparé à celui du site');
});

test('redirections : c’est le fichier RELU qui fait foi', () => {
  // Écrire n'est pas réussir. Le script relit et compare ; au moindre écart il efface
  // ce qu'il vient de poser plutôt que de laisser un fichier à moitié écrit.
  assert.match(PHP_REDIRECTS, /clearstatcache/);
  assert.match(PHP_REDIRECTS, /@file_get_contents\(\$f\) !== \$contenu/);
  assert.match(PHP_REDIRECTS, /@unlink\(\$f\)/);
  // Et une sauvegarde est prise avant toute écriture.
  assert.match(PHP_REDIRECTS, /\.lkm-backups/);
});

test('redirections : le registre est reconstruit depuis ce qui EXISTE', () => {
  // Un registre qui annoncerait une redirection disparue mentirait à l'agent : il
  // croirait une adresse couverte alors qu'elle rend 404.
  assert.match(PHP_REDIRECTS, /\$verifie = \[\]/);
  assert.match(PHP_REDIRECTS, /lireStub\(\$f, \$MARQUE\)/);
});

test('redirections : les fichiers posés sont lisibles par le compte DU SITE', () => {
  // PHP tourne sous le compte du site, qui n'appartient qu'à son propre groupe — ni
  // www-data, ni editors. En 0640, un fichier créé par le compte SSH lui serait
  // totalement inaccessible, et la redirection ne partirait jamais. Mesuré le
  // 02/10/2026, avant correction.
  assert.match(PHP_REDIRECTS, /@chmod\(\$f, 0644\)/);
  assert.match(PHP_REDIRECTS, /@chmod\(\$fReg, 0644\)/);
});

test('redirections : le registre est invisible depuis le web', () => {
  // nginx refuse tout chemin commençant par un point (« location ~ /\. »), vérifié en
  // direct : 403. Les sauvegardes vivent dans un dossier du même genre — un
  // « 404.php.20261002 » posé dans public_html ne finirait pas par « .php » et serait
  // servi en clair, exposant le code du site.
  assert.match(PHP_REDIRECTS, /'\.lkm-redirects\.json'/);
  assert.match(PHP_REDIRECTS, /\$doc \. '\/\.lkm-backups'/);
});

test('redirections : l’écran ne propose plus un choix sans effet', () => {
  // Le sélecteur « RewriteRule / Redirect 301 » ne décidait plus de rien sous nginx, et
  // laissait croire le contraire — ce qui est pire que pas de choix du tout.
  const ecran = readFileSync(join(RACINE, 'public/js/redirects.js'), 'utf8');
  assert.ok(!/^\s+selecteurFormat\(\),$/m.test(ecran), 'le sélecteur ne doit plus être rendu');
  assert.match(ecran, /export const ligne = \(\{ from, to \}\) =>/, 'l’aperçu montre ce qui est réellement posé');
  assert.ok(!/RewriteRule \$\{motif/.test(ecran), 'plus d’aperçu en forme Apache');
});

test('redirections : les deux états nouveaux sont nommés dans les six langues', () => {
  // Un état sans libellé s'afficherait en clé brute à l'agent — c'est exactement ce qui
  // était arrivé aux droits Cloudflare.
  for (const langue of ['fr', 'en', 'es', 'it', 'pt', 'de']) {
    const textes = JSON.parse(readFileSync(join(RACINE, 'locales', `${langue}.json`), 'utf8'));
    for (const etat of ['exists', 'unsupported', 'to_add', 'present', 'conflict']) {
      const libelle = textes.redirects?.[`state_${etat}`];
      assert.equal(typeof libelle, 'string', `${langue} : « redirects.state_${etat} » manque`);
      assert.ok(libelle.trim().length > 0);
    }
  }
});

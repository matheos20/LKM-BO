/**
 * Scripts PHP exécutés sur le serveur du site.
 *
 * Pourquoi PHP plutôt qu'un analyseur maison : `config.php` et les articles SONT du PHP.
 * Les faire lire par l'interpréteur du site lui-même garantit une interprétation exacte,
 * là où une expression régulière finirait par se tromper.
 *
 * Transport : le script arrive par l'entrée standard (`php` sans argument lit stdin) et
 * les données entrantes passent en base64 dans une variable d'environnement. Aucun
 * fichier temporaire, aucun problème de guillemets.
 */

/** Variables de configuration reconnues par le moteur du parc. */
export const CONFIG_VARS = [
  'site_name',
  'site_icon',
  'site_tagline',
  'site_lang',
  'header_nav',
  'header_logo',
  'header_cta',
  'header_cta_text',
  'header_cta_url',
  'footer_style',
  'footer_show',
  'category_style',
  'categories',
  'homepage_sections',
  'homepage',
  'article_style',
];

const VARS_PHP = CONFIG_VARS.map((v) => `'${v}'`).join(', ');

/** Lecture complète d'un site : configuration, charte, sections disponibles, images. */
export const READ_SITE = `<?php
error_reporting(0);
$doc = getenv('LKM_DOC');
$known = [${VARS_PHP}];

$loadConfig = function ($file) use ($known) {
    if (!is_file($file)) return null;
    ob_start();
    include $file;
    ob_end_clean();
    $all = get_defined_vars();
    unset($all['file'], $all['known']);
    $data = [];
    $extra = [];
    foreach ($all as $name => $value) {
        if (in_array($name, $known, true)) $data[$name] = $value;
        else $extra[$name] = var_export($value, true);
    }
    return ['data' => $data, 'extra' => $extra];
};

$out = ['docroot' => $doc];
$cfgFile = $doc . '/config.php';
$cfg = $loadConfig($cfgFile);
$out['config'] = $cfg['data'] ?? null;
$out['extraVars'] = $cfg['extra'] ?? [];
$out['configMeta'] = is_file($cfgFile) ? ['md5' => md5_file($cfgFile), 'mtime' => filemtime($cfgFile), 'size' => filesize($cfgFile)] : null;

// Charte graphique : variables CSS de style.css
$cssFile = $doc . '/style.css';
$css = is_file($cssFile) ? file_get_contents($cssFile) : '';
$style = [];
if (preg_match_all('/--([a-z0-9-]+)\\s*:\\s*([^;]+);/i', $css, $m, PREG_SET_ORDER)) {
    foreach ($m as $x) $style[$x[1]] = trim($x[2]);
}
$out['style'] = $style;
$out['styleMeta'] = is_file($cssFile) ? ['md5' => md5_file($cssFile), 'mtime' => filemtime($cssFile)] : null;

// Bibliothèque de sections réellement présente sur ce site
$sections = [];
foreach (glob($doc . '/parts/sections/*.php') ?: [] as $f) {
    $b = basename($f, '.php');
    if (strpos($b, '.bak') === false && strpos($b, '.pre-') === false) $sections[] = $b;
}
sort($sections);
$out['sections'] = $sections;

// Images disponibles (identifiants dérivés des fichiers -600.jpg)
$images = [];
foreach (glob($doc . '/images/*-600.jpg') ?: [] as $f) $images[] = basename($f, '-600.jpg');
sort($images);
$out['images'] = $images;

// Articles : le fichier de permaliens donne l'adresse publique…
$permalinks = [];
if (is_file($doc . '/permalinks.php')) {
    $p = (function ($f) { ob_start(); include $f; ob_end_clean(); return $permalinks ?? []; })($doc . '/permalinks.php');
    $permalinks = is_array($p) ? $p : [];
}
$out['articles'] = [];
$seen = [];
$category = function ($rel) { return strpos($rel, '/') === false ? '' : strstr($rel, '/', true); };
foreach ($permalinks as $file => $url) {
    $out['articles'][] = ['file' => $file, 'url' => $url, 'category' => $category($file)];
    $seen[$file] = true;
}

// …mais des sites du parc ont un fichier de permaliens vide alors que les articles
// existent sur le disque : sans ce parcours, l'éditeur les déclarerait sans article.
// Est retenu comme article un fichier qui porte le bloc $article_meta du moteur.
$skip = ['parts', 'images', 'fonts', 'page', 'admin', 'cache', 'assets'];
foreach (glob($doc . '/*', GLOB_ONLYDIR) ?: [] as $dir) {
    $slug = basename($dir);
    if ($slug[0] === '.' || in_array($slug, $skip, true)) continue;
    foreach (glob($dir . '/*.php') ?: [] as $path) {
        $name = basename($path);
        $rel = $slug . '/' . $name;
        if ($name === 'index.php' || isset($seen[$rel])) continue;
        if (strpos((string) file_get_contents($path, false, null, 0, 400), '$article_meta') === false) continue;
        $out['articles'][] = ['file' => $rel, 'url' => '', 'category' => $slug];
        $seen[$rel] = true;
    }
}
usort($out['articles'], fn($a, $b) => strcmp($a['file'], $b['file']));

echo json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
`;

/** Métadonnées d'une page d'articles : profite du garde $meta_only du moteur. */
export const READ_ARTICLE_METAS = `<?php
error_reporting(0);
$doc = getenv('LKM_DOC');
$files = json_decode(base64_decode(getenv('LKM_B64')), true) ?: [];
$out = [];
foreach ($files as $rel) {
    $path = $doc . '/' . $rel;
    if (!is_file($path)) { $out[] = ['file' => $rel, 'missing' => true]; continue; }
    $meta = (function ($f) {
        $meta_only = true;
        ob_start();
        include $f;
        ob_end_clean();
        return $article_meta ?? null;
    })($path);
    $out[] = ['file' => $rel, 'meta' => $meta, 'mtime' => filemtime($path), 'md5' => md5_file($path)];
}
echo json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
`;

/**
 * Lecture d'un article : métadonnées interprétées par PHP, corps HTML brut, et
 * POSITIONS exactes des deux blocs modifiables. Le back-office remplace ensuite
 * ces tranches d'octets sans toucher au reste du fichier.
 * Analyse par recherche de chaînes plutôt que par expression régulière : pas
 * d'échappement fragile, et un échec se voit immédiatement (bloc absent).
 */
export const READ_ARTICLE = `<?php
error_reporting(0);
$doc = getenv('LKM_DOC');
$rel = base64_decode(getenv('LKM_B64'));
$path = $doc . '/' . $rel;
if (!is_file($path)) { echo json_encode(['missing' => true]); exit; }

$meta = (function ($f) {
    $meta_only = true;
    ob_start();
    include $f;
    ob_end_clean();
    return $article_meta ?? null;
})($path);

$raw = file_get_contents($path);

// Bloc des métadonnées : de "$article_meta = [" jusqu'à la ligne "];"
$metaStart = strpos($raw, '$article_meta');
$metaEnd = null;
if ($metaStart !== false) {
    $close = strpos($raw, "\\n];", $metaStart);
    if ($close !== false) $metaEnd = $close + 3;
}

// Corps : heredoc nowdoc  $content = <<<'TAG' ... TAG;
$content = null; $tag = null; $bodyStart = null; $bodyEnd = null;
$cPos = strpos($raw, '$content');
if ($cPos !== false) {
    $open = strpos($raw, "<<<'", $cPos);
    if ($open !== false) {
        $quote = strpos($raw, "'", $open + 4);
        $tag = substr($raw, $open + 4, $quote - ($open + 4));
        $nl = strpos($raw, "\\n", $quote);
        if ($nl !== false && $tag !== '') {
            $bodyStart = $nl + 1;
            $needle = "\\n" . $tag . ';';
            $stop = strpos($raw, $needle, $bodyStart);
            if ($stop !== false) { $bodyEnd = $stop; $content = substr($raw, $bodyStart, $stop - $bodyStart); }
        }
    }
}

$category = null;
$catPos = strpos($raw, '$category');
if ($catPos !== false) {
    $q1 = strpos($raw, "'", $catPos);
    $q2 = $q1 === false ? false : strpos($raw, "'", $q1 + 1);
    if ($q2 !== false) $category = substr($raw, $q1 + 1, $q2 - $q1 - 1);
}

echo json_encode([
    'file' => $rel,
    'meta' => $meta,
    'category' => $category,
    'content' => $content,
    'heredocTag' => $tag,
    'offsets' => ['metaStart' => $metaStart === false ? null : $metaStart, 'metaEnd' => $metaEnd, 'bodyStart' => $bodyStart, 'bodyEnd' => $bodyEnd],
    'raw' => base64_encode($raw),
    'md5' => md5_file($path),
    'mtime' => filemtime($path),
    'size' => filesize($path),
], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
`;

/**
 * Rendu d'une page avec le brouillon, dans un dossier de travail sous /tmp.
 *
 * Le moteur du site (parts/, homepage.php, article.php) y a été recopié, mais la
 * configuration et la charte sont celles du brouillon : la page produite est donc
 * exactement ce que donnerait une publication, sans rien écrire dans le site.
 */
export const RENDER_PAGE = `<?php
error_reporting(0);
$tmp = getenv('LKM_TMP');
$page = getenv('LKM_PAGE');   // chemin relatif dans le dossier de travail
$host = getenv('LKM_HOST');
$file = $tmp . '/' . $page;
if (!is_file($file)) { echo json_encode(['error' => 'page introuvable']); exit; }

$_SERVER['HTTP_HOST'] = $host;
$_SERVER['SERVER_NAME'] = $host;
$_SERVER['REQUEST_URI'] = getenv('LKM_URI') ?: '/';
$_SERVER['REQUEST_METHOD'] = 'GET';
$_SERVER['SCRIPT_FILENAME'] = $file;
$_SERVER['SCRIPT_NAME'] = '/' . $page;
$_SERVER['HTTPS'] = 'on';

ob_start();
include $file;
$html = ob_get_clean();

// Polices du site : le back-office sert la prévisualisation depuis sa propre origine,
// où un .woff2 distant serait refusé (CORS). On les renvoie donc avec la page pour
// les embarquer en data: — la typographie réelle reste visible.
$fonts = [];
$budget = 1400000;
foreach (glob(getenv('LKM_DOC') . '/fonts/*.{woff2,woff}', GLOB_BRACE) ?: [] as $f) {
    $size = filesize($f);
    if ($size <= 0 || $size > $budget) continue;
    $budget -= $size;
    $fonts[basename($f)] = base64_encode(file_get_contents($f));
}
echo json_encode(['html' => $html, 'fonts' => $fonts], JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
`;

/**
 * Vérification d'un fichier de configuration candidat : syntaxe PHP valide,
 * puis relecture des variables pour comparer avec l'intention (aller-retour).
 */
export const VERIFY_CONFIG = `<?php
error_reporting(0);
$path = getenv('LKM_PATH');
$known = [${VARS_PHP}];
$lint = [];
exec('php -l ' . escapeshellarg($path) . ' 2>&1', $lint, $code);
if ($code !== 0) { echo json_encode(['ok' => false, 'lint' => implode("\\n", $lint)]); exit; }
$data = (function ($f, $known) {
    ob_start();
    include $f;
    ob_end_clean();
    $all = get_defined_vars();
    unset($all['f'], $all['known']);
    $out = [];
    foreach ($all as $k => $v) if (in_array($k, $known, true)) $out[$k] = $v;
    return $out;
})($path, $known);
echo json_encode(['ok' => true, 'config' => $data], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
`;

/**
 * Import d'une image : produit les déclinaisons attendues par le moteur du parc.
 *
 * Convention relevée sur les sites : `<id>-<largeur>.<ext>` pour les largeurs
 * 400, 600, 900 et 1920, en WebP et en JPEG, plus une entrée dans `manifest.json`
 * qui sert d'index. L'image source arrive dans un fichier temporaire : elle ne peut
 * pas passer par l'entrée standard, déjà occupée par ce script.
 */
export const WRITE_IMAGE = `<?php
error_reporting(0);
$doc = getenv('LKM_DOC');
$src = getenv('LKM_SRC');
$id = getenv('LKM_ID');
$dir = $doc . '/images';
$fail = function ($message) { echo json_encode(['error' => $message]); exit; };

if (!preg_match('/^[a-z0-9][a-z0-9-]{0,79}$/', (string) $id)) $fail('identifiant invalide');
if (!is_dir($dir)) $fail('dossier images introuvable');
if (!is_writable($dir)) $fail('dossier images en lecture seule (domaine verrouille ?)');

$data = @file_get_contents($src);
if ($data === false || strlen($data) === 0) $fail('image absente');
$info = @getimagesizefromstring($data);
if (!$info || empty($info[0])) $fail('fichier illisible comme image');
$image = @imagecreatefromstring($data);
if (!$image) $fail('format d image non pris en charge');

// Le JPEG ignore la transparence : on aplatit sur blanc avant toute conversion.
$w = imagesx($image);
$h = imagesy($image);
$flat = imagecreatetruecolor($w, $h);
imagefill($flat, 0, 0, imagecolorallocate($flat, 255, 255, 255));
imagecopy($flat, $image, 0, 0, 0, 0, $w, $h);
imagedestroy($image);

$written = [];
foreach ([400, 600, 900, 1920] as $width) {
    $target = min($width, $w); // jamais d'agrandissement : on ne fabrique pas de détail
    $height = max(1, (int) round($h * $target / $w));
    $thumb = imagescale($flat, $target, $height, IMG_BICUBIC);
    if (!$thumb) continue;
    $base = $dir . '/' . $id . '-' . $width;
    // WebP d'abord, JPEG ensuite : même ordre que les manifestes déjà en place.
    if (@imagewebp($thumb, $base . '.webp', 82)) { @chmod($base . '.webp', 0664); $written[] = basename($base) . '.webp'; }
    if (@imagejpeg($thumb, $base . '.jpg', 82)) { @chmod($base . '.jpg', 0664); $written[] = basename($base) . '.jpg'; }
    imagedestroy($thumb);
}
imagedestroy($flat);
if (!$written) $fail('aucune declinaison n a pu etre ecrite');

$manifestFile = $dir . '/manifest.json';
$manifest = is_file($manifestFile) ? json_decode((string) file_get_contents($manifestFile), true) : [];
if (!is_array($manifest)) $manifest = [];
$manifest[$id] = ['files' => $written];
ksort($manifest);
@file_put_contents($manifestFile, json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n");

@unlink($src);
echo json_encode(['id' => $id, 'files' => $written, 'width' => $w, 'height' => $h], JSON_UNESCAPED_SLASHES);
`;

/**
 * Repérage des textes rédigés dans une autre langue que celle du site.
 *
 * Un lot de domaines est analysé en une seule exécution : sur un parc de plusieurs
 * milliers de sites, ouvrir une session par domaine coûterait des heures. Chaque site
 * est lu par PHP lui-même, dans une portée isolée, et une erreur de syntaxe dans un
 * `config.php` n'interrompt pas le lot (`ParseError` est rattrapable depuis PHP 7).
 *
 * Entrées : LKM_ROOT (racine des sites), LKM_B64 (liste JSON de domaines), LKM_MIN (score
 * minimal). Sortie : { sites: [ { domain, lang, source, texts, items[] } ] }.
 */
export const SCAN_LANG = `<?php
error_reporting(0);
$root = rtrim((string) getenv('LKM_ROOT'), '/');
$min = max(1, (int) (getenv('LKM_MIN') ?: 2));
$domains = json_decode((string) base64_decode((string) getenv('LKM_B64'), true), true);
if (!is_array($domains)) $domains = [];

// Mots outils : ils ne portent pas de sens, mais trahissent la langue d'un texte.
// Ils sont écrits sans accent ; les textes des sites sont ramenés à la même forme.
$STOP = [
 // Le français porte des mots outils que les autres listes ignorent (je, mes, cet,
 // lorsque…). Sans eux, une phrase française courte se faisait prendre pour du
 // néerlandais, dont la liste contient « je », « en » et « de ».
 'FR' => "le la les des une un du de et ou pour avec vous nous votre notre nos est sont plus tous toutes qui que sur aux leur leurs chez sans entre vers quand comment pourquoi dans cette ces mais donc alors aussi tres toujours jamais chaque plusieurs ete etre avoir fait faire peut doit ne pas plus rien tout je moi ma mon mes ta tes ton cet ainsi encore depuis lorsque afin deja meme autre autres beaucoup bien sous selon grace notamment",
 'UK' => "the and for with your our you this that are all more about best from how why what guide tips have has can will their there when which while each every into over also just because we us it is of to in on an or but if by be was not they them its my one than then now here who out up",
 'ES' => "el la los las una unos unas para con tu tus su sus nuestro nuestra mas todos todas que como sobre donde cuando porque pero tambien siempre nunca cada varios ser estar hacer puede debe desde entre sin no en de",
 'PT' => "os as uma umas para com seu sua nosso nossa mais todos todas que como sobre onde quando porque mas tambem sempre nunca cada varios ser estar fazer pode deve desde entre sem nao voce em de",
 'IT' => "il lo la gli le una uno per con tuo tua nostro nostra piu tutti tutte che come dove quando perche ma anche sempre mai ogni diversi essere fare puo deve da tra senza sono questo questa di in",
 'DE' => "der die das den dem ein eine einen und oder fur mit ihre ihr unser unsere mehr alle diese dieser wie wo wann warum aber auch immer nie jeder mehrere sein haben kann muss von zwischen ohne nicht ist sie es wir uns ihnen am im zum zur beim bei nach aus durch uber unter sich noch nur schon sehr wird werden wurde sind hat hatte dass wenn weil damit dann als",
 'NL' => "de het een en of voor met uw jouw onze meer alle deze hoe waar wanneer waarom maar ook altijd nooit elke verschillende zijn hebben kan moet van tussen zonder niet je is te dat om aan er wij ons wordt worden naar nog dan zo bij dit die",
];
foreach ($STOP as $k => $v) $STOP[$k] = array_flip(preg_split('/\\s+/', trim($v)));

function sansAccent(string $s): string {
    $t = @iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $s);
    return $t === false ? $s : strtolower($t);
}

/**
 * Mots de la marque du site : ils ne prouvent aucune langue.
 *
 * « Explorez l'univers Be You Tiful » est du français sur be-you-tiful.fr, mais « be »
 * et « you » sont deux mots outils anglais : le texte passait pour de l'anglais sur son
 * propre site. Le nom de domaine et le nom du site sont donc retirés du calcul.
 */
$MARQUE = [];

/** Langue dominante d'un texte : [langue, score, score du suivant, nombre de mots, tous les scores]. */
function langue(string $s): array {
    global $STOP, $MARQUE;
    $nu = strip_tags(html_entity_decode($s, ENT_QUOTES | ENT_HTML5, 'UTF-8'));
    $mots = preg_split("/[^\\p{L}']+/u", mb_strtolower($nu), -1, PREG_SPLIT_NO_EMPTY);
    if (count($mots) < 3) return [null, 0, 0, count($mots), []];
    $sc = [];
    foreach ($STOP as $lg => $set) {
        $n = 0;
        foreach ($mots as $m) { $plat = sansAccent($m); if (isset($set[$plat]) && !isset($MARQUE[$plat])) $n++; }
        // Élisions : marqueur propre au français, qu'une liste de mots ne voit pas.
        if ($lg === 'FR') $n += preg_match_all("/(^|[\\s>«\\"'])(l'|d'|qu'|n'|s'|j'|m'|c'est)/iu", $nu);
        $sc[$lg] = $n;
    }
    arsort($sc);
    $v = array_values($sc);
    return [array_key_first($sc), $v[0], $v[1] ?? 0, count($mots), $sc];
}

/** Ces valeurs ne sont pas de la prose : les traduire casserait le site. */
function technique(string $chemin): bool {
    $feuille = strtolower((string) substr((string) strrchr('.' . $chemin, '.'), 1));
    return (bool) preg_match('/^(url|href|link|slug|id|image|img|icon|color|colour|class|style|type|mode|key|name)$/', $feuille);
}

/** Aplatit une valeur de configuration en chemins « homepage.hero.title ». */
function aplatir($v, string $chemin, array &$out): void {
    if (is_string($v)) {
        if (mb_strlen(trim($v)) > 2 && !technique($chemin)) $out[$chemin] = $v;
        return;
    }
    if (is_array($v)) foreach ($v as $k => $x) aplatir($x, $chemin === '' ? (string) $k : $chemin . '.' . $k, $out);
}

/** Variables de config.php, lues par PHP lui-même, dans une portée isolée. */
function config(string $file): array {
    return (function ($f) { ob_start(); include $f; ob_end_clean(); return get_defined_vars(); })($file);
}

/** Langue du site : site_lang, puis extension du domaine, puis contenu. */
function cible(array $data, string $domain): array {
    global $STOP;
    $l = strtoupper(trim((string) ($data['site_lang'] ?? '')));
    $l = ['EN' => 'UK', 'GB' => 'UK', 'US' => 'UK', 'BR' => 'PT', 'MX' => 'ES', 'AT' => 'DE', 'BE' => 'NL'][$l] ?? $l;
    if (isset($STOP[$l])) return [$l, 'config', $l];

    $tld = strtolower((string) substr((string) strrchr($domain, '.'), 1));
    $parTld = ['fr' => 'FR', 'es' => 'ES', 'pt' => 'PT', 'br' => 'PT', 'de' => 'DE', 'at' => 'DE',
               'it' => 'IT', 'nl' => 'NL', 'be' => 'NL', 'uk' => 'UK', 'ie' => 'UK'];
    if (isset($parTld[$tld])) return [$parTld[$tld], 'tld', $tld];

    $textes = [];
    foreach (['site_tagline', 'homepage'] as $k) if (isset($data[$k])) aplatir($data[$k], $k, $textes);
    $votes = [];
    foreach ($textes as $t) { [$lg, $s1] = langue($t); if ($lg) $votes[$lg] = ($votes[$lg] ?? 0) + $s1; }
    if ($votes) { arsort($votes); return [array_key_first($votes), 'content', '']; }
    return ['FR', 'default', ''];
}

$sites = [];
foreach ($domains as $domain) {
    $domain = (string) $domain;
    if (!preg_match('/^[a-z0-9][a-z0-9.-]{1,252}$/i', $domain)) continue;
    $file = $root . '/' . $domain . '/public_html/config.php';
    $site = ['domain' => $domain];
    if (!is_file($file)) { $site['error'] = 'missing'; $sites[] = $site; continue; }
    // Un config.php illisible ne doit pas emporter tout le lot avec lui.
    try {
        $data = config($file);
    } catch (\\Throwable $e) {
        $site['error'] = 'unreadable';
        $sites[] = $site;
        continue;
    }

    // La marque est établie AVANT toute analyse : elle vaut pour la langue du site
    // comme pour celle de chaque texte.
    $MARQUE = [];
    $nomDomaine = preg_replace('/\\.[a-z]{2,10}$/i', '', $domain);
    foreach (preg_split("/[^\\p{L}]+/u", mb_strtolower($nomDomaine . ' ' . (string) ($data['site_name'] ?? '')), -1, PREG_SPLIT_NO_EMPTY) as $mot) {
        $MARQUE[sansAccent($mot)] = true;
    }

    [$lang, $source, $hint] = cible($data, $domain);
    $textes = [];
    foreach (['site_tagline', 'header_cta_text', 'homepage'] as $k) if (isset($data[$k])) aplatir($data[$k], $k, $textes);

    $items = [];
    $labels = [];
    $analyses = [];
    foreach ($textes as $chemin => $texte) {
        [$lg, $s1, $s2, $nbMots, $sc] = langue($texte);
        // Trop court pour être reconnu statistiquement : « Nos articles », « Découvrir »…
        // Ces libellés reviennent partout, le back-office les compare à son dictionnaire.
        if (!$lg) {
            if (mb_strlen($texte) <= 40) $labels[] = ['path' => $chemin, 'text' => $texte];
            continue;
        }
        $analyses[$chemin] = ['lg' => $lg, 's1' => $s1, 's2' => $s2, 'mots' => $nbMots, 'site' => $sc[$lang] ?? 0, 'texte' => $texte];
    }

    // PREMIER TOUR — les intrus francs, ceux qu'on peut affirmer sans rien savoir du site.
    $retenus = [];
    $averes = [];
    foreach ($analyses as $chemin => $a) {
        if ($a['lg'] === $lang || $a['s1'] < $min || $a['s1'] <= $a['s2']) continue;
        // Le texte doit devancer nettement LA LANGUE DU SITE, pas seulement la deuxième
        // du classement : « Transformer la donnée biologique en levier de longévité »
        // marque 3 en espagnol (la, en, de) contre 2 en français, sans être espagnol
        // pour autant. Les langues latines partagent trop de mots outils pour qu'un
        // écart de un suffise.
        $ecartSite = $a['s1'] - $a['site'];
        if ($ecartSite < 2) continue;
        $retenus[$chemin] = true;
        $averes[$a['lg']] = true;
        // Sur quatre mots, deux mots outils communs à deux langues trompent encore
        // l'analyse : ces cas sont signalés « à vérifier » plutôt qu'écartés, et
        // l'agent n'en voit aucun coché d'office.
        $items[] = ['path' => $chemin, 'lang' => $a['lg'], 'score' => $a['s1'], 'gap' => min($a['s1'] - $a['s2'], $ecartSite), 'words' => $a['mots'], 'text' => $a['texte']];
    }

    // SECOND TOUR — une langue déjà prise en faute sur CE site n'a plus à convaincre
    // autant. « Architectes du code, compilez ! » ne marque qu'un point (« du ») :
    // beaucoup trop peu pour accuser un site au hasard, largement assez quand deux
    // autres textes de la même page sont déjà du français avéré. Le relevé restait
    // sinon incomplet là où le travail est justement à faire.
    foreach ($analyses as $chemin => $a) {
        if (isset($retenus[$chemin]) || $a['lg'] === $lang) continue;
        if (!isset($averes[$a['lg']]) || $a['s1'] < 1 || $a['s1'] <= $a['site']) continue;
        $items[] = ['path' => $chemin, 'lang' => $a['lg'], 'score' => $a['s1'], 'gap' => min($a['s1'] - $a['s2'], $a['s1'] - $a['site']), 'words' => $a['mots'], 'text' => $a['texte'], 'weak' => true];
    }
    $site['labels'] = $labels;
    $site['lang'] = $lang;
    $site['source'] = $source;
    $site['hint'] = $hint;
    $site['texts'] = count($textes);
    $site['items'] = $items;
    $sites[] = $site;
}

echo json_encode(['sites' => $sites], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
`;

/**
 * Mots visibles restés en français dans les GABARITS d'un site (\`parts/\`, pages du
 * moteur, \`sitemap.php\`…), et leur correction.
 *
 * Trois différences de fond avec SCAN_LANG, qui traite \`config.php\` :
 *
 *   1. AUCUNE analyse statistique. Les gabarits contiennent des tables multilingues
 *      — \`$_copyright_texts = ['FR' => …, 'ES' => …]\` — qu'une détection par
 *      fréquence de mots signalerait à tort sur chaque site du parc. Seules les
 *      correspondances EXACTES du dictionnaire sont retenues.
 *   2. Le lexique du site fait autorité : \`$lang['home'] ?? 'Accueil'\` se corrige avec
 *      la valeur de \`parts/lang.php\` pour la langue du site, sans deviner.
 *   3. Le fichier est relu par l'analyseur de PHP lui-même (\`token_get_all\`), jamais
 *      par une expression régulière : une chaîne dans un commentaire, un heredoc ou
 *      une interpolation ne peut pas être prise pour du texte affiché.
 *
 * Les ARTICLES sont écartés : ils ont leur propre éditeur, et leur contenu n'est pas
 * du gabarit. Les adresses (\`*_url\`, \`/chemin\`, \`https://…\`) sont écartées aussi :
 * traduire un lien changerait la destination, pas le mot lu par le visiteur.
 *
 * Entrées : LKM_ROOT, LKM_B64 (domaines), LKM_DICT (dictionnaires par langue),
 *           LKM_MODE (scan | apply), LKM_CHANGES (corrections retenues, en mode apply).
 */
export const TEMPLATE_TEXTS = String.raw`<?php
error_reporting(0);
$root = rtrim((string) getenv('LKM_ROOT'), '/');
$mode = getenv('LKM_MODE') === 'apply' ? 'apply' : 'scan';
$domains = json_decode((string) base64_decode((string) getenv('LKM_B64'), true), true) ?: [];
$DICOS = json_decode((string) base64_decode((string) getenv('LKM_DICT'), true), true) ?: [];
$RETENUS = json_decode((string) base64_decode((string) getenv('LKM_CHANGES'), true), true) ?: [];
$LANGS = ['FR', 'UK', 'ES', 'PT', 'DE', 'IT', 'NL'];

/** Clé de comparaison : casse, accents et espaces ne doivent pas séparer deux variantes. */
function cle(string $s): string {
    $t = @iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $s);
    if ($t === false) $t = $s;
    $t = strtolower(preg_replace('/\s+/u', ' ', $t));
    return trim($t, " \t\n\r\0\x0B.:;!?");
}

/** Décorations d'un libellé : flèches, chevrons, puces. Le cœur seul est traduit. */
function noyau(string $s, &$avant, &$apres): string {
    $avant = ''; $apres = '';
    // Les mêmes décorations des deux côtés : un chevron de fil d'Ariane se place aussi
    // bien avant qu'après le libellé (« Accueil › Plan du site »).
    $deco = ['&larr;', '&rarr;', '&laquo;', '&raquo;', '&lsaquo;', '&rsaquo;', '&nbsp;', '&middot;',
             '←', '→', '«', '»', '‹', '›', '•', '·', '–', '—', '…', '-', '|', '/'];
    $g = $deco;
    $d = $deco;
    $c = $s;
    do {
        $chg = false;
        $t = ltrim($c);
        if ($t !== $c) { $avant .= substr($c, 0, strlen($c) - strlen($t)); $c = $t; $chg = true; }
        foreach ($g as $m) if ($m !== '' && strpos($c, $m) === 0) { $avant .= $m; $c = substr($c, strlen($m)); $chg = true; }
    } while ($chg && $c !== '');
    do {
        $chg = false;
        $t = rtrim($c);
        if ($t !== $c) { $apres = substr($c, strlen($t)) . $apres; $c = $t; $chg = true; }
        foreach ($d as $m) if ($m !== '' && $m !== $c && substr($c, -strlen($m)) === $m) { $apres = $m . $apres; $c = substr($c, 0, -strlen($m)); $chg = true; }
    } while ($chg && $c !== '');
    return $c;
}

/**
 * Mots outils qui trahissent une phrase française. Ils ne servent qu'à SIGNALER à
 * l'agent ce qu'aucun dictionnaire ne sait traduire — jamais à modifier un fichier.
 */
$MARQUEURS = ['vous', 'nous', 'votre', 'notre', 'nos', 'avec', 'pour', 'dans', 'cette', 'ces',
              'leurs', 'ainsi', 'chez', 'tres', 'toutes', 'aussi', 'alors', 'depuis', 'selon',
              'vers', 'toujours', 'jamais', 'pourquoi', 'lecture', 'rubrique', 'rubriques',
              'retrouvez', 'decouvrez', 'notre', 'sont', 'etre'];

function ressembleAuFrancais(string $v): bool {
    global $MARQUEURS;
    $f = ' ' . cle($v) . ' ';
    if (mb_strlen($v) < 8 || mb_strlen($v) > 200) return false;
    foreach ($MARQUEURS as $m) if (strpos($f, ' ' . $m . ' ') !== false) return true;
    return false;
}

/** Une adresse, un identifiant, un nom de fichier : jamais un mot lu par le visiteur. */
function technique(string $v): bool {
    if ($v === '' || mb_strlen($v) > 120) return true;
    if (preg_match('#^(https?:|//|/|\#|mailto:|tel:)#i', $v)) return true;
    if (preg_match('/\.(php|css|js|jpe?g|png|webp|svg|ico|json|xml|txt)$/i', $v)) return true;
    if (preg_match('/^[a-z0-9_.\/-]+$/', $v)) return true;   // slug, classe, clé
    if (!preg_match('/\p{L}{2}/u', $v)) return true;
    return false;
}

/** Valeur d'une chaîne PHP littérale. */
function valeur(string $lit): string {
    $q = $lit[0] ?? '';
    $c = substr($lit, 1, -1);
    if ($q === "'") return strtr($c, ["\\'" => "'", '\\\\' => '\\']);
    if ($q === '"') return stripcslashes($c);
    return $lit;
}

/** Chaîne PHP entre apostrophes. */
function litteral(string $v): string {
    return "'" . strtr($v, ['\\' => '\\\\', "'" => "\\'"]) . "'";
}

/**
 * Les fichiers que le visiteur voit réellement.
 *
 * Trois sortes de PHP cohabitent dans un site du parc, et une seule est affichée :
 *   - les PAGES servies par une adresse (index.php, 404.php, sitemap.php…) ;
 *   - les MORCEAUX qu'elles incluent (parts/header.php, parts/footer.php…), plus les
 *     53 gabarits de parts/sections/, inclus par un nom calculé à l'exécution ;
 *   - les OUTILS et les données : config.php, permalinks.php, parts/lang.php, et des
 *     fichiers que personne n'inclut — parts/_scan_.php est dans ce cas sur tout le
 *     parc. Rien de tout cela n'atteint un navigateur : on n'y touche pas.
 *
 * Les articles sont écartés à part : ils ont leur propre éditeur.
 */
function fichiersVus(string $doc): array {
    $racine = glob($doc . '/*.php') ?: [];
    $parts = glob($doc . '/parts/*.php') ?: [];
    $sections = glob($doc . '/parts/sections/*.php') ?: [];

    // Un article n'est ni une page du moteur ni un morceau inclus : il est écarté
    // d'emblée, avant toute lecture complète. Un site en porte parfois des centaines.
    $pages = [];
    foreach ($racine as $f) {
        $tete = (string) @file_get_contents($f, false, null, 0, 600);
        if (strpos($tete, '$article_meta') !== false) continue;
        $pages[] = $f;
    }

    // Ce que le site inclut, d'où que ce soit : on ne retient de parts/ que cela.
    // La lecture est entière — un include de pied de page se trouve en fin de fichier.
    $inclus = [];
    foreach (array_merge($pages, $parts, $sections) as $f) {
        $src = (string) @file_get_contents($f);
        if (preg_match_all('/(?:include|require)(?:_once)?[^;]{0,120};/', $src, $m)) {
            foreach ($m[0] as $ligne) {
                if (preg_match_all('#[\x27"]([^\x27"]*?([A-Za-z0-9_-]+\.php))[\x27"]#', $ligne, $n, PREG_SET_ORDER)) {
                    foreach ($n as $cible) $inclus[strtolower($cible[2])] = true;
                }
            }
        }
    }

    $donnees = ['config.php' => true, 'permalinks.php' => true, 'lang.php' => true];
    $out = [];
    foreach ($pages as $f) {
        $nom = basename($f);
        // Un fichier dont le nom commence par « _ » n'est pas une page du site.
        if ($nom[0] === '_' || isset($donnees[$nom]) || strpos($nom, '.bak') !== false) continue;
        $out[] = $f;   // servie par une adresse : le visiteur peut y arriver
    }
    foreach ($parts as $f) {
        $nom = basename($f);
        if ($nom[0] === '_' || isset($donnees[$nom]) || strpos($nom, '.bak') !== false) continue;
        if (!isset($inclus[strtolower($nom)])) continue;   // inclus par personne : outil
        $out[] = $f;
    }
    foreach ($sections as $f) {
        // Les sections sont incluses par un nom calculé : aucune trace en clair, mais
        // elles composent la page d'accueil de chaque site.
        $nom = basename($f);
        if ($nom[0] === '_' || strpos($nom, '.bak') !== false) continue;
        $out[] = $f;
    }
    sort($out);
    return $out;
}

/** Le lexique du site : parts/lang.php, lu par PHP lui-même. */
function lexique(string $doc): ?array {
    $f = $doc . '/parts/lang.php';
    if (!is_file($f)) return null;
    $t = (function ($file) {
        ob_start();
        include $file;
        ob_end_clean();
        return $translations ?? null;
    })($f);
    return is_array($t) ? $t : null;
}

/**
 * Nœuds de texte d'un bloc HTML : ce que le visiteur lit, hors balises.
 * Rend une liste de [position, longueur, texte].
 */
function noeuds(string $html): array {
    $out = []; $n = strlen($html); $i = 0;
    while ($i < $n) {
        if ($html[$i] === '<') {
            $f = strpos($html, '>', $i);
            if ($f === false) break;
            $i = $f + 1;
            continue;
        }
        $f = strpos($html, '<', $i);
        $len = ($f === false ? $n : $f) - $i;
        if ($len > 0) $out[] = [$i, $len, substr($html, $i, $len)];
        $i += $len;
    }
    return $out;
}

/** Index des tokens significatifs (espaces et commentaires ignorés). */
function signifiants(array $tokens): array {
    $out = [];
    foreach ($tokens as $i => $tok) {
        if (is_array($tok) && in_array($tok[0], [T_WHITESPACE, T_COMMENT, T_DOC_COMMENT], true)) continue;
        $out[] = $i;
    }
    return $out;
}

$sites = [];
foreach ($domains as $domain) {
    $domain = (string) $domain;
    if (!preg_match('/^[a-z0-9][a-z0-9.-]{1,252}$/i', $domain)) continue;
    $doc = $root . '/' . $domain . '/public_html';
    $site = ['domain' => $domain, 'items' => []];
    if (!is_file($doc . '/config.php')) { $site['error'] = 'missing'; $sites[] = $site; continue; }

    $cfg = (string) @file_get_contents($doc . '/config.php');
    $lang = preg_match('/\$site_lang\s*=\s*[\x27"]([A-Za-z]{2})[\x27"]/', $cfg, $m) ? strtoupper($m[1]) : 'FR';
    $lang = ['EN' => 'UK', 'GB' => 'UK', 'US' => 'UK', 'BR' => 'PT', 'MX' => 'ES', 'AT' => 'DE', 'BE' => 'NL'][$lang] ?? $lang;
    if (!in_array($lang, $LANGS, true)) $lang = 'FR';
    $site['lang'] = $lang;
    if ($lang === 'FR') { $site['skip'] = 'source'; $sites[] = $site; continue; }

    $lex = lexique($doc);
    if ($lex === null || !isset($lex[$lang])) { $site['skip'] = 'lexicon'; $sites[] = $site; continue; }
    $TO = $lex[$lang];

    // Le dictionnaire de CE site. Le lexique fait autorité : chacune de ses clés donne
    // une paire « valeur française → valeur de la langue du site », soit une vingtaine
    // de mots propres au site, là où un dictionnaire figé n'en connaîtrait aucun.
    $DICO = [];
    foreach (($lex['FR'] ?? []) as $k => $v) {
        if (!is_string($v) || substr($k, -4) === '_url') continue;   // une adresse n'est pas un mot lu
        $t = $TO[$k] ?? null;
        if (!is_string($t) || mb_strlen($v) < 4 || cle($v) === cle($t)) continue;
        $DICO[cle($v)] = $t;
    }
    // Puis le dictionnaire du parc et les mots ajoutés par les agents, sans écraser le lexique.
    foreach (($DICOS[$lang] ?? []) as $fr => $to) {
        if (!isset($DICO[cle($fr)])) $DICO[cle($fr)] = $to;
    }

    $site['todo'] = [];
    $signales = [];
    foreach (fichiersVus($doc) as $chemin) {
        $rel = ltrim(str_replace($doc, '', $chemin), '/');
        $src = (string) @file_get_contents($chemin);
        if ($src === '') continue;
        // Un article n'est pas un gabarit : il a son propre éditeur.
        if (strpos(substr($src, 0, 600), '$article_meta') !== false) continue;

        try { $tokens = token_get_all($src); } catch (\Throwable $e) { continue; }
        $sig = signifiants($tokens);
        $aRemplacer = [];   // index de token => nouveau texte
        $vus = [];          // index de token déjà traités par la passe A

        // Une table multilingue est une DONNÉE, pas un oubli de traduction : le site y
        // choisit sa ligne à l'affichage. Les deux formes se rencontrent sur le parc :
        //   $_copyright_texts = ['FR' => 'Tous droits réservés', 'UK' => '…'];
        //   $t404 = ['FR' => ['back' => 'Retour à l\'accueil', …], 'UK' => […]];
        // La seconde couvrait la page 404 de chaque site : sans cette garde, le
        // français source y passait pour un reste à corriger.
        $protege = [];
        foreach ($sig as $pos => $idx) {
            $tok = $tokens[$idx];
            if (!is_array($tok) || $tok[0] !== T_CONSTANT_ENCAPSED_STRING) continue;
            if (!in_array(strtoupper(valeur($tok[1])), $LANGS, true)) continue;
            $fleche = $tokens[$sig[$pos + 1] ?? -1] ?? null;
            if (!is_array($fleche) || $fleche[0] !== T_DOUBLE_ARROW) continue;
            $debut = $sig[$pos + 2] ?? null;
            if ($debut === null) continue;
            $ouvrant = $tokens[$debut];
            $estTableau = $ouvrant === '[' || (is_array($ouvrant) && $ouvrant[0] === T_ARRAY);
            if (!$estTableau) { $protege[$debut] = true; continue; }
            $prof = 0;
            for ($j = $debut, $fin = count($tokens); $j < $fin; $j++) {
                $c = is_array($tokens[$j]) ? $tokens[$j][1] : $tokens[$j];
                if ($c === '[' || $c === '(') $prof++;
                elseif ($c === ']' || $c === ')') { $prof--; if ($prof <= 0) break; }
                $protege[$j] = true;
            }
        }

        // ── Passe A : $lang['cle'] ?? 'Texte français' ─────────────────────
        for ($k = 0; $k + 5 < count($sig); $k++) {
            $t0 = $tokens[$sig[$k]];
            if (!is_array($t0) || $t0[0] !== T_VARIABLE || $t0[1] !== '$lang') continue;
            if ($tokens[$sig[$k + 1]] !== '[') continue;
            $tc = $tokens[$sig[$k + 2]];
            if (!is_array($tc) || $tc[0] !== T_CONSTANT_ENCAPSED_STRING) continue;
            if ($tokens[$sig[$k + 3]] !== ']') continue;
            $tq = $tokens[$sig[$k + 4]];
            if (!is_array($tq) || $tq[0] !== T_COALESCE) continue;
            $tv = $tokens[$sig[$k + 5]];
            if (!is_array($tv) || $tv[0] !== T_CONSTANT_ENCAPSED_STRING) continue;

            $key = valeur($tc[1]);
            // Une adresse traduite changerait la destination du lien, pas un mot lu.
            if (substr($key, -4) === '_url' || !isset($TO[$key]) || !is_string($TO[$key])) continue;
            $de = valeur($tv[1]);
            $vers = $TO[$key];
            $vus[$sig[$k + 5]] = true;
            if ($de === $vers) continue;
            $aRemplacer[$sig[$k + 5]] = ['kind' => 'lexique', 'line' => $tv[2], 'from' => $de, 'to' => $vers, 'new' => litteral($vers)];
        }

        // ── Passe B : littéraux connus du dictionnaire ─────────────────────
        foreach ($sig as $pos => $idx) {
            $tok = $tokens[$idx];
            if (!is_array($tok) || $tok[0] !== T_CONSTANT_ENCAPSED_STRING || isset($vus[$idx])) continue;
            if (isset($protege[$idx])) continue;   // table multilingue : donnée, pas oubli
            $v = valeur($tok[1]);
            if ($tok[1][0] === '"' && preg_match('/[$\{]/', $tok[1])) continue;
            $coeur = noyau($v, $av, $ap);
            if (technique($coeur)) continue;
            $trad = $DICO[cle($coeur)] ?? null;
            if ($trad === null || $trad === $coeur) {
                // Aucun dictionnaire ne connaît ce texte : s'il a l'air français, l'agent
                // doit le savoir — c'est à lui d'ajouter le mot, ou de corriger à la main.
                if (ressembleAuFrancais($coeur) && !isset($signales[cle($coeur)])) {
                    $signales[cle($coeur)] = true;
                    $site['todo'][] = ['file' => $rel, 'line' => $tok[2], 'text' => mb_substr($coeur, 0, 160)];
                }
                continue;
            }
            $aRemplacer[$idx] = ['kind' => 'texte', 'line' => $tok[2], 'from' => $coeur, 'to' => $trad, 'new' => litteral($av . $trad . $ap)];
        }

        // ── Passe C : texte visible du HTML ────────────────────────────────
        foreach ($tokens as $idx => $tok) {
            if (!is_array($tok) || $tok[0] !== T_INLINE_HTML) continue;
            $html = $tok[1];
            $sortie = ''; $curseur = 0; $touche = false; $premier = null;
            foreach (noeuds($html) as [$debut, $len, $texte]) {
                $coeur = noyau($texte, $av, $ap);
                if (technique($coeur)) continue;
                $trad = $DICO[cle($coeur)] ?? null;
                if ($trad === null || $trad === $coeur) {
                    if (ressembleAuFrancais($coeur) && !isset($signales[cle($coeur)])) {
                        $signales[cle($coeur)] = true;
                        $site['todo'][] = ['file' => $rel, 'line' => $tok[2] + substr_count(substr($html, 0, $debut), chr(10)), 'text' => mb_substr($coeur, 0, 160)];
                    }
                    continue;
                }
                $sortie .= substr($html, $curseur, $debut - $curseur) . $av . $trad . $ap;
                $curseur = $debut + $len;
                $touche = true;
                // Le bloc HTML peut couvrir plusieurs lignes : on situe le texte, pas le bloc.
                if ($premier === null) $premier = [$coeur, $trad, $tok[2] + substr_count(substr($html, 0, $debut), chr(10))];
            }
            if (!$touche) continue;
            $sortie .= substr($html, $curseur);
            $aRemplacer[$idx] = ['kind' => 'html', 'line' => $premier[2], 'from' => $premier[0], 'to' => $premier[1], 'new' => $sortie];
        }

        if (!$aRemplacer) continue;
        foreach ($aRemplacer as $idx => $r) {
            $site['items'][] = ['file' => $rel, 'line' => $r['line'], 'kind' => $r['kind'], 'from' => $r['from'], 'to' => $r['to']];
        }

        // ── Écriture ───────────────────────────────────────────────────────
        if ($mode !== 'apply') continue;
        $choix = $RETENUS[$domain][$rel] ?? null;
        $sortie = ''; $ecrits = 0;
        foreach ($tokens as $idx => $tok) {
            $brut = is_array($tok) ? $tok[1] : $tok;
            if (!isset($aRemplacer[$idx])) { $sortie .= $brut; continue; }
            $r = $aRemplacer[$idx];
            // L'agent a pu décocher : on ne réécrit que ce qu'il a retenu.
            $retenu = $choix === null;
            if (!$retenu) foreach ($choix as $c) {
                if (($c['line'] ?? 0) == $r['line'] && ($c['from'] ?? '') === $r['from']) { $retenu = true; break; }
            }
            if (!$retenu) { $sortie .= $brut; continue; }
            $sortie .= $r['new'];
            $ecrits++;
        }
        if ($ecrits === 0) continue;

        $tmp = $chemin . '.lkm-new';
        if (@file_put_contents($tmp, $sortie) === false) { $site['failed'][] = $rel; continue; }
        exec('php -l ' . escapeshellarg($tmp) . ' 2>&1', $sortieLint, $code);
        if ($code !== 0) { @unlink($tmp); $site['failed'][] = $rel; continue; }
        $bk = $doc . '/.lkm-backups/templates';
        @mkdir($bk . '/' . dirname($rel), 0775, true);
        @copy($chemin, $bk . '/' . $rel . '.' . date('Ymd-His'));
        // cat plutôt que rename : propriétaire, droits et ACL du fichier d'origine sont conservés.
        if (@file_put_contents($chemin, $sortie) === false) { @unlink($tmp); $site['failed'][] = $rel; continue; }
        @unlink($tmp);
        $site['written'][] = ['file' => $rel, 'count' => $ecrits];
    }
    $sites[] = $site;
}

echo json_encode(['sites' => $sites, 'mode' => $mode], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
`;

/**
 * Rubriques d'un site : le dossier qui la sert, et le résumé WordPress.
 *
 * Une rubrique du parc est faite de trois choses, et il en manque toujours une quand
 * on les ajoute à la main :
 *   1. un dossier `<slug>/index.php` de trois lignes, qui passe la main à category.php ;
 *   2. une entrée dans `$categories` de config.php — écrite par le back-office, pas ici,
 *      car elle mérite le circuit de publication complet (validation, php -l, relecture) ;
 *   3. une ligne dans `wp_summary.json`, que la synchronisation WordPress lit.
 *
 * Ce script s'occupe de la première et de la troisième. Il ne remplace jamais ce qui
 * existe : une rubrique déjà en place est signalée, pas réécrite.
 *
 * La SUPPRESSION suit le chemin inverse, avec une règle qui ne se discute pas : les
 * articles ne sont jamais touchés. Un dossier de rubrique en contient — sur le parc,
 * `hardware/` en porte sept — et leurs adresses publiques viennent de
 * `permalinks.php`, pas du dossier. Sont donc retirés la page de la rubrique
 * (`index.php`), son entrée de menu et sa ligne de résumé ; le dossier ne disparaît
 * que s'il ne reste rien dedans.
 *
 * Entrées : LKM_ROOT, LKM_OP (add | remove), LKM_MODE (scan | apply),
 *           LKM_B64 (domaine → [{slug, name}]).
 */
/**
 * Les rubriques réellement déclarées sur des sites, avec ce qu'elles pèsent.
 *
 * Écrit pour la suppression : l'agent ne peut pas deviner la clé interne d'une
 * rubrique qu'il n'a pas créée. « Finance &amp; real estate » se range sous
 * `finance-real-estate`, et aucun nom tapé à la main ne retombe dessus. On lit donc
 * les clés telles qu'elles sont, et c'est cette clé qui repartira.
 *
 * Le nombre d'articles est compté ici parce qu'il décide de tout : la suppression
 * retire la page de la rubrique, jamais les articles, et l'agent doit le voir avant.
 */
export const CATEGORY_LIST = String.raw`<?php
error_reporting(0);
$root = rtrim((string) getenv('LKM_ROOT'), '/');
$domaines = json_decode((string) base64_decode((string) getenv('LKM_B64'), true), true) ?: [];

$sites = [];
foreach ($domaines as $domain) {
    $domain = (string) $domain;
    if (!preg_match('/^[a-z0-9][a-z0-9.-]{1,252}$/i', $domain)) continue;
    $doc = $root . '/' . $domain . '/public_html';
    $site = ['domain' => $domain, 'items' => []];
    if (!is_file($doc . '/config.php')) { $site['error'] = 'missing'; $sites[] = $site; continue; }

    $cats = (function ($f) { ob_start(); include $f; ob_end_clean(); return $categories ?? []; })($doc . '/config.php');
    if (!is_array($cats)) $cats = [];

    foreach ($cats as $cle => $val) {
        $cle = (string) $cle;
        // Ce que le moteur du site sait servir : une clé qui tient dans une adresse.
        if (!preg_match('/^[a-z0-9][a-z0-9-]{0,60}$/', $cle)) continue;
        $dossier = $doc . '/' . $cle;
        // Tout ce que le dossier contient hors index.php, ce sont des articles.
        $restes = is_dir($dossier) ? array_values(array_diff(scandir($dossier) ?: [], ['.', '..', 'index.php'])) : [];
        $site['items'][] = [
            'slug' => $cle,
            // Le nom affiché sert à l'agent ; c'est la clé qui sert à la machine.
            'name' => html_entity_decode((string) (is_array($val) ? ($val['name'] ?? $cle) : $val), ENT_QUOTES | ENT_HTML5, 'UTF-8'),
            'articles' => count($restes),
            'dir' => is_file($dossier . '/index.php'),
        ];
    }
    $sites[] = $site;
}

echo json_encode(['sites' => $sites], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
`;

export const CATEGORY_FILES = String.raw`<?php
error_reporting(0);
$root = rtrim((string) getenv('LKM_ROOT'), '/');
$mode = getenv('LKM_MODE') === 'apply' ? 'apply' : 'scan';
$op = getenv('LKM_OP') === 'remove' ? 'remove' : 'add';
$demande = json_decode((string) base64_decode((string) getenv('LKM_B64'), true), true) ?: [];
$stamp = date('Ymd-His');

/** Les rubriques déjà déclarées dans config.php, lues par PHP lui-même. */
function categoriesActuelles(string $fichier): array {
    $c = (function ($f) {
        ob_start();
        include $f;
        ob_end_clean();
        return $categories ?? [];
    })($fichier);
    return is_array($c) ? $c : [];
}

$sites = [];
foreach ($demande as $domain => $rubriques) {
    $domain = (string) $domain;
    if (!preg_match('/^[a-z0-9][a-z0-9.-]{1,252}$/i', $domain) || !is_array($rubriques)) continue;
    $doc = $root . '/' . $domain . '/public_html';
    $site = ['domain' => $domain, 'items' => []];

    if (!is_file($doc . '/config.php')) { $site['error'] = 'missing'; $sites[] = $site; continue; }
    // Sans category.php, le dossier créé n'aurait rien à afficher. Pour une
    // suppression, en revanche, son absence n'empêche rien.
    if ($op === 'add' && !is_file($doc . '/category.php')) { $site['error'] = 'engine'; $sites[] = $site; continue; }

    $config = categoriesActuelles($doc . '/config.php');
    $jsonFile = $doc . '/wp_summary.json';
    $resume = is_file($jsonFile) ? json_decode((string) @file_get_contents($jsonFile), true) : null;
    $site['summary'] = is_array($resume);
    $liste = is_array($resume) ? ($resume['wp_categories_list'] ?? []) : [];
    $slugsJson = [];
    foreach ($liste as $ligne) if (isset($ligne['slug'])) $slugsJson[$ligne['slug']] = true;

    $ajoutsJson = 0;
    foreach ($rubriques as $r) {
        $slug = (string) ($r['slug'] ?? '');
        $nom = trim((string) ($r['name'] ?? ''));
        if (!preg_match('/^[a-z0-9][a-z0-9-]{0,60}$/', $slug) || $nom === '') continue;

        $dossier = $doc . '/' . $slug;
        $index = $dossier . '/index.php';
        // Tout ce que le dossier contient d'autre, ce sont des articles.
        $restes = is_dir($dossier) ? array_values(array_diff(scandir($dossier) ?: [], ['.', '..', 'index.php'])) : [];
        $etat = [
            'slug' => $slug,
            // Pour une suppression, le nom sert à l'agent : on le lui montre lisible,
            // comme le visiteur le voit. Pour une création, il part tel quel dans
            // config.php et ne doit surtout pas être réécrit.
            'name' => $op === 'remove'
                ? html_entity_decode((string) (($config[$slug]['name'] ?? '') ?: $nom), ENT_QUOTES | ENT_HTML5, 'UTF-8')
                : $nom,
            // Trois pièces, trois états : ce qui existe déjà n'est jamais réécrit.
            'dir' => is_file($index),
            'config' => isset($config[$slug]),
            'json' => isset($slugsJson[$slug]),
            'articles' => count($restes),
            'done' => [],
            'failed' => [],
        ];

        if ($op === 'remove') {
            if ($mode === 'apply') {
                if ($etat['dir']) {
                    if (@unlink($index)) {
                        $etat['dir'] = false;
                        $etat['done'][] = 'dir';
                        // Le dossier ne s'en va que s'il ne reste rien : les articles priment.
                        if (!$restes) @rmdir($dossier);
                    } else {
                        $etat['failed'][] = 'dir';
                    }
                }
                if (is_array($resume) && $etat['json']) {
                    $liste = array_values(array_filter($liste, fn($l) => ($l['slug'] ?? '') !== $slug));
                    unset($slugsJson[$slug]);
                    $etat['json'] = false;
                    $etat['done'][] = 'json';
                    $ajoutsJson++;
                }
            }
            $site['items'][] = $etat;
            continue;
        }

        if ($mode === 'apply' && !$etat['dir']) {
            $dossier = dirname($index);
            $contenu = "<?php\n" . '$category = ' . var_export($slug, true) . ";\n" . "include __DIR__ . '/../category.php';\n";
            if ((is_dir($dossier) || @mkdir($dossier, 0755, true)) && @file_put_contents($index, $contenu) !== false) {
                @chmod($index, 0644);
                $etat['dir'] = true;
                $etat['done'][] = 'dir';
            } else {
                $etat['failed'][] = 'dir';
            }
        }

        if ($mode === 'apply' && is_array($resume) && !$etat['json']) {
            $liste[] = ['slug' => $slug, 'name' => $nom];
            $slugsJson[$slug] = true;
            $etat['json'] = true;
            $etat['done'][] = 'json';
            $ajoutsJson++;
        }

        $site['items'][] = $etat;
    }

    if ($mode === 'apply' && $ajoutsJson > 0 && is_array($resume)) {
        $resume['wp_categories_list'] = array_values($liste);
        $resume['wp_categories'] = count($liste);
        @copy($jsonFile, $jsonFile . '.bak-' . $stamp);
        if (@file_put_contents($jsonFile, json_encode($resume, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)) === false) {
            $site['jsonFailed'] = true;
        }
    }

    $sites[] = $site;
}

echo json_encode(['sites' => $sites, 'mode' => $mode], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
`;

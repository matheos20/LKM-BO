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

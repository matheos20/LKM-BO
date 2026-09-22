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

import { shq } from '../ssh/shell.js';

/**
 * Commandes exécutées sur le serveur du site pour l'éditeur de design et de contenu.
 *
 * Deux principes :
 *   - la PRÉVISUALISATION n'écrit jamais dans le site : le moteur est recopié dans un
 *     dossier de travail sous /tmp, où seuls la configuration et la charte du brouillon
 *     diffèrent. Elle fonctionne donc même sur un domaine verrouillé, et ne laisse rien ;
 *   - la PUBLICATION sauvegarde d'abord, contrôle la syntaxe PHP ensuite, et n'écrit le
 *     fichier final qu'après ces deux étapes.
 *
 * Les contenus volumineux arrivent par l'entrée standard (base64), jamais par la ligne
 * de commande, dont la taille est limitée par le noyau.
 */

export const BACKUP_DIR = '.lkm-backups';
const RENDER_ROOT = '/tmp/lkm-render';

/** Fichiers du moteur recopiés dans le dossier de rendu temporaire. */
const ENGINE_FILES = ['homepage.php', 'article.php', 'category.php', 'critical.css'];

/** Exécute un script PHP fourni sur stdin, dans le contexte du site. */
export const phpCommand = (docroot, env = {}) => {
  const vars = Object.entries({ LKM_DOC: docroot, ...env })
    .map(([k, v]) => `${k}=${shq(v)}`)
    .join(' ');
  return `${vars} php`;
};

/**
 * Prépare le rendu d'une prévisualisation, entièrement sous /tmp.
 * Le config.php du brouillon arrive sur l'entrée standard, la charte par l'environnement.
 */
export function prepareRenderCommand(docroot, token, { styleB64 = '' } = {}) {
  const tmp = `${RENDER_ROOT}-${token}`;
  return [
    `DOC=${shq(docroot)}`,
    `TMP=${shq(tmp)}`,
    // Purge des rendus abandonnés (plus d'une heure).
    `find /tmp -maxdepth 1 -name 'lkm-render-*' -type d -mmin +60 -exec rm -rf {} + 2>/dev/null`,
    `rm -rf "$TMP"`,
    `mkdir -p "$TMP/page" || exit 70`,
    `cp -r "$DOC/parts" "$TMP/parts" || exit 71`,
    `rm -f "$TMP/parts"/*.bak* "$TMP/parts"/*.pre-* 2>/dev/null`,
    ...ENGINE_FILES.map((f) => `[ -e "$DOC/${f}" ] && cp "$DOC/${f}" "$TMP/${f}" 2>/dev/null`),
    `base64 -d > "$TMP/config.php" || exit 73`,
    styleB64
      ? `printf '%s' ${shq(styleB64)} | base64 -d > "$TMP/style.css" || exit 74`
      : `[ -f "$DOC/style.css" ] && cp "$DOC/style.css" "$TMP/style.css"`,
    `php -l "$TMP/config.php" > /dev/null || exit 76`,
    `echo ok`,
  ]
    .filter(Boolean)
    .join('\n');
}

const RENDER_DIR_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;
/** Dossiers du moteur recopiés dans le dossier de travail : une page ne s'y dépose jamais. */
const RESERVED_DIRS = new Set(['parts', 'images', 'fonts']);

/**
 * Dossier dans lequel rendre une page.
 *
 * Certaines versions du moteur déduisent la rubrique d'un article du nom de son dossier
 * (`$category = basename(__DIR__)`). Rendu depuis un dossier technique, l'article perdait
 * sa rubrique : fil d'Ariane vide, et des liens vers une adresse inexistante que le site
 * renvoie à l'accueil. L'article est donc rendu dans un dossier qui porte le nom de sa
 * vraie rubrique ; la page d'accueil, elle, garde « page/ ».
 *
 * Aucun risque de redirection canonique : `permalinks.php` n'est jamais recopié dans le
 * dossier de travail, le moteur n'y trouve donc aucune adresse vers laquelle renvoyer.
 */
export function renderDirFor(articleRel) {
  const rel = String(articleRel ?? '');
  const dir = rel.split('/')[0];
  return rel.includes('/') && RENDER_DIR_RE.test(dir) && !RESERVED_DIRS.has(dir) ? dir : 'page';
}

/** Dépose la page à rendre dans le dossier de travail, puis en vérifie la syntaxe. */
export function renderPageCommand(token, name, dir = 'page') {
  if (!RENDER_DIR_RE.test(dir)) throw new Error('dossier de rendu invalide');
  const target = `"$TMP/"${shq(`${dir}/${name}`)}`;
  return [
    `TMP=${shq(`${RENDER_ROOT}-${token}`)}`,
    `[ -d "$TMP" ] || exit 75`,
    `mkdir -p "$TMP/"${shq(dir)} || exit 70`,
    `base64 -d > ${target} || exit 73`,
    `php -l ${target} > /dev/null || exit 76`,
    `echo ok`,
  ].join('\n');
}

/** Supprime un dossier de rendu temporaire. */
export const dropRenderCommand = (token) => `rm -rf ${shq(`${RENDER_ROOT}-${token}`)}; echo ok`;

export const renderTmpPath = (token) => `${RENDER_ROOT}-${token}`;

/**
 * Publication : sauvegarde horodatée, contrôle de syntaxe, puis écriture sur place
 * (l'écriture par `cat >` conserve propriétaire, droits et ACL du fichier d'origine).
 */
export function publishCommand(docroot, { styleB64 = '', expectMd5 = '' } = {}) {
  return [
    `DOC=${shq(docroot)}`,
    `BK="$DOC/${BACKUP_DIR}"`,
    `STAMP=$(date +%Y%m%d-%H%M%S)`,
    expectMd5 ? `[ "$(md5sum "$DOC/config.php" | cut -d" " -f1)" = ${shq(expectMd5)} ] || exit 80` : '',
    `mkdir -p "$BK" || exit 81`,
    // Le fichier produit est écrit et CONTRÔLÉ avant qu'on touche à quoi que ce soit :
    // un fichier refusé par PHP ne doit pas consommer une place de sauvegarde, ni
    // faire tourner les dix précédentes.
    `TMP="$BK/.new-config.php"`,
    `base64 -d > "$TMP" || exit 82`,
    `php -l "$TMP" > /dev/null || { rm -f "$TMP"; exit 83; }`,
    `[ -f "$DOC/config.php" ] && cp -a "$DOC/config.php" "$BK/config-$STAMP.php"`,
    `[ -f "$DOC/style.css" ] && cp -a "$DOC/style.css" "$BK/style-$STAMP.css"`,
    `cat "$TMP" > "$DOC/config.php" || exit 84`,
    `rm -f "$TMP"`,
    styleB64
      ? `printf '%s' ${shq(styleB64)} | base64 -d > "$BK/.new-style.css" && cat "$BK/.new-style.css" > "$DOC/style.css" && rm -f "$BK/.new-style.css" || exit 85`
      : '',
    // On ne conserve que les dix dernières sauvegardes de chaque type.
    `ls -1t "$BK"/config-*.php 2>/dev/null | tail -n +11 | xargs -r rm -f`,
    `ls -1t "$BK"/style-*.css 2>/dev/null | tail -n +11 | xargs -r rm -f`,
    `echo "$STAMP"`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Écriture d'un article : sauvegarde, contrôle de syntaxe, écriture sur place. */
export function writeArticleCommand(docroot, rel, { expectMd5 = '' } = {}) {
  return [
    `DOC=${shq(docroot)}`,
    `REL=${shq(rel)}`,
    `F="$DOC/$REL"`,
    `[ -f "$F" ] || exit 86`,
    expectMd5 ? `[ "$(md5sum "$F" | cut -d" " -f1)" = ${shq(expectMd5)} ] || exit 80` : '',
    `BK="$DOC/${BACKUP_DIR}/articles"`,
    `STAMP=$(date +%Y%m%d-%H%M%S)`,
    `mkdir -p "$BK/$(dirname "$REL")" || exit 81`,
    `cp -a "$F" "$BK/$REL.$STAMP" || exit 81`,
    `TMP="$BK/.new-article.php"`,
    `base64 -d > "$TMP" || exit 82`,
    `php -l "$TMP" > /dev/null || { rm -f "$TMP"; exit 83; }`,
    `cat "$TMP" > "$F" || exit 84`,
    `rm -f "$TMP"`,
    `ls -1t "$BK/$REL".* 2>/dev/null | tail -n +6 | xargs -r rm -f`,
    `echo "$STAMP"`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Sauvegardes disponibles : chemin relatif, taille, date du fichier.
 *
 * Le parcours descend dans les SOUS-DOSSIERS : les sauvegardes d'article vivent dans
 * « articles/ », et une recherche à un seul niveau les manquait toutes. Sur
 * 1bighostel.com, l'onglet annonçait « aucune sauvegarde » alors qu'il y en avait une.
 *
 * La date du fichier n'est donnée qu'à titre de secours : « cp -a » conserve celle de
 * l'original, si bien qu'une sauvegarde faite le 29 septembre portait le 30 août. Le
 * moment réel est dans le NOM, et c'est lui qui fait foi.
 */
export const listBackupsCommand = (docroot) =>
  [
    `BK=${shq(`${docroot}/${BACKUP_DIR}`)}`,
    `[ -d "$BK" ] || { echo; exit 0; }`,
    `find "$BK" -type f -printf '%P\\t%s\\t%T@\\n' | sort -r`,
  ].join('\n');

/**
 * Restauration d'une sauvegarde vers son fichier d'origine.
 *
 * La destination est calculée par l'appelant à partir du nom de la sauvegarde, jamais
 * reçue du navigateur. Un fichier PHP repasse par le contrôle de syntaxe avant d'être
 * remis : une sauvegarde abîmée mettrait la page en erreur, même si elle vient de nous.
 */
export function restoreCommand(docroot, backupName, target) {
  return [
    `DOC=${shq(docroot)}`,
    `SRC="$DOC/${BACKUP_DIR}/"${shq(backupName)}`,
    `[ -f "$SRC" ] || exit 87`,
    `DST="$DOC/"${shq(target)}`,
    target.endsWith('.php') ? `php -l "$SRC" > /dev/null || exit 83` : '',
    `mkdir -p "$(dirname "$DST")" || exit 81`,
    `cat "$SRC" > "$DST" || exit 84`,
    `echo restored`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Suppression d'une sauvegarde. Rien d'autre que le fichier nommé n'est touché. */
export const deleteBackupCommand = (docroot, backupName) =>
  [
    `DOC=${shq(docroot)}`,
    `SRC="$DOC/${BACKUP_DIR}/"${shq(backupName)}`,
    `[ -f "$SRC" ] || exit 87`,
    `rm -f "$SRC" || exit 84`,
    `echo deleted`,
  ].join('\n');

/** Contenu d'une sauvegarde et du fichier en place, pour les comparer avant d'agir. */
export const readBackupCommand = (docroot, backupName, target) =>
  [
    `DOC=${shq(docroot)}`,
    `SRC="$DOC/${BACKUP_DIR}/"${shq(backupName)}`,
    `[ -f "$SRC" ] || exit 87`,
    `echo '--- LKM-AVANT ---'`,
    `head -c 200000 "$SRC"`,
    `echo`,
    `echo '--- LKM-APRES ---'`,
    `[ -f "$DOC/"${shq(target)} ] && head -c 200000 "$DOC/"${shq(target)} || true`,
  ].join('\n');

export const EXIT_MESSAGES = {
  70: 'errors.design_preview_failed',
  71: 'errors.design_preview_failed',
  73: 'errors.design_preview_failed',
  74: 'errors.design_preview_failed',
  75: 'errors.design_preview_failed',
  76: 'errors.design_lint_failed',
  80: 'errors.design_conflict',
  81: 'errors.design_write_denied',
  82: 'errors.design_write_denied',
  83: 'errors.design_lint_failed',
  84: 'errors.design_write_denied',
  85: 'errors.design_write_denied',
  86: 'errors.file_not_found',
  87: 'errors.file_not_found',
};

/**
 * Dépose l'image reçue dans un fichier temporaire du serveur.
 * Le script PHP qui fabrique les déclinaisons arrive, lui, par l'entrée standard :
 * l'image ne peut donc pas emprunter le même chemin.
 */
export const stageImageCommand = (token) => `cat > ${shq(imageTmpPath(token))}`;
export const dropImageCommand = (token) => `rm -f ${shq(imageTmpPath(token))}; echo ok`;
export const imageTmpPath = (token) => `/tmp/lkm-image-${token}`;

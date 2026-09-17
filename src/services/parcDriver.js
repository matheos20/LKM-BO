import { shq } from '../ssh/shell.js';

/**
 * Pilote du modèle « parc » : 1 vhost nginx mutualisé, 1 domaine = <wwwRoot>/<domaine>/public_html.
 * Verrou = attribut immuable (chattr +i) sur public_html, posé par le compte lockop.
 * Toutes les valeurs dynamiques sont quotées via shq() ; les domaines sont validés en amont.
 */

export const ACTIONS = ['create', 'delete', 'fixPerms', 'lock', 'unlock'];

/** Une seule commande pour lister tout le parc (~0,5 s pour 8 000 domaines). */
export function listCommand(s) {
  const lines = [
    `cd -- ${shq(s.wwwRoot)} || exit 3`,
    `echo '#DIRS'`,
    `find . -mindepth 1 -maxdepth 1 -printf '%f\\t%y\\t%T@\\n'`,
    `echo '#LOCK'`,
    `lsattr -d -- */public_html 2>/dev/null || true`,
  ];
  if (s.registry) lines.push(`echo '#REG'`, `cat -- ${shq(s.registry)} 2>/dev/null || true`);
  if (s.canonFile) lines.push(`echo '#CANON'`, `grep -E '^[[:space:]]+[^[:space:]]+[[:space:]]+1;' -- ${shq(s.canonFile)} 2>/dev/null || true`);
  lines.push(`echo '#END'`);
  return lines.join('\n');
}

export function parseList(stdout) {
  const items = new Map();
  const locks = new Map();
  const reg = new Map();
  const canon = new Set();
  let section = null;

  for (const line of stdout.split('\n')) {
    if (line.startsWith('#')) {
      section = line.slice(1).trim();
      continue;
    }
    if (!line) continue;
    if (section === 'DIRS') {
      const [name, type, mtime] = line.split('\t');
      if (!name || name.startsWith('.') || (type !== 'd' && type !== 'l')) continue;
      items.set(name, { name, storage: type === 'l' ? 'link' : 'dir', mtime: Math.round(Number(mtime) * 1000) || null });
    } else if (section === 'LOCK') {
      const i = line.indexOf(' ');
      const p = line.slice(i + 1);
      if (i > 0 && p.endsWith('/public_html')) locks.set(p.slice(0, -'/public_html'.length), line.slice(0, i).includes('i'));
    } else if (section === 'REG') {
      const [d, u] = line.split('\t');
      if (d && u) reg.set(d, u.trim());
    } else if (section === 'CANON') {
      const m = line.trim().match(/^(\S+)\s+1;$/);
      if (m) canon.add(m[1]);
    }
  }

  return [...items.values()].map((it) => ({
    ...it,
    status: locks.has(it.name) ? (locks.get(it.name) ? 'locked' : 'unlocked') : 'incomplete',
    siteUser: reg.get(it.name) ?? null,
    wwwCanon: canon.has(it.name),
  }));
}

/** État léger d'un domaine : missing | incomplete | locked | unlocked. */
export function statusCommand(s, domain) {
  return [
    `B=${shq(s.wwwRoot)}/${shq(domain)}`,
    `[ -e "$B" ] || { echo missing; exit 0; }`,
    `a=$(lsattr -d -- "$B/public_html" 2>/dev/null | cut -d' ' -f1)`,
    `if [ -z "$a" ]; then echo incomplete; else case "$a" in *i*) echo locked;; *) echo unlocked;; esac; fi`,
  ].join('\n');
}

export function detailsCommand(s, domain) {
  const sock = shq(s.phpSocketDir || '/run/php');
  return [
    `D=${shq(domain)}; B=${shq(s.wwwRoot)}/"$D"; P="$B/public_html"`,
    `[ -e "$B" ] || exit 44`,
    `kv(){ printf '%s\\t%s\\n' "$1" "$2"; }`,
    `kv real "$(readlink -f -- "$B")"`,
    `kv link "$([ -L "$B" ] && echo 1 || echo 0)"`,
    `kv owner "$(stat -L -c %U -- "$B" 2>/dev/null)"`,
    `kv group "$(stat -L -c %G -- "$B" 2>/dev/null)"`,
    `kv docroot "$([ -d "$P" ] && echo 1 || echo 0)"`,
    `kv mtime "$(stat -L -c %Y -- "$P" 2>/dev/null)"`,
    `kv attrs "$(lsattr -d -- "$P" 2>/dev/null | cut -d' ' -f1)"`,
    `kv writable "$([ -w "$P" ] && echo 1 || echo 0)"`,
    `kv size "$(timeout 15 du -sb -- "$B/" 2>/dev/null | cut -f1)"`,
    `kv files "$(timeout 15 find "$P" -type f 2>/dev/null | wc -l)"`,
    `kv index "$(cd -- "$P" 2>/dev/null && ls -1 index.php index.html 2>/dev/null | head -n1)"`,
    `kv socket "$([ -S ${sock}/"$D".sock ] && echo ${sock}/"$D".sock)"`,
    s.registry ? `kv siteUser "$(awk -F'\\t' -v d="$D" '$1==d{print $2; exit}' ${shq(s.registry)} 2>/dev/null)"` : '',
    s.canonFile ? `kv wwwCanon "$(awk -v d="$D" '$1==d && $2=="1;"{f=1} END{print f+0}' ${shq(s.canonFile)} 2>/dev/null)"` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function parseDetails(stdout, s, domain) {
  const kv = Object.fromEntries(stdout.split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('\t')), l.slice(l.indexOf('\t') + 1)]));
  const num = (v) => (v === undefined || v === '' ? null : Number(v));
  const hasDocroot = kv.docroot === '1';
  return {
    name: domain,
    path: `${s.wwwRoot}/${domain}`,
    realPath: kv.real || null,
    docroot: `${s.wwwRoot}/${domain}/public_html`,
    storage: kv.link === '1' ? 'link' : 'dir',
    owner: kv.owner || null,
    group: kv.group || null,
    status: !hasDocroot || !kv.attrs ? 'incomplete' : kv.attrs.includes('i') ? 'locked' : 'unlocked',
    writable: kv.writable === '1',
    mtime: num(kv.mtime) && num(kv.mtime) * 1000,
    size: num(kv.size),
    files: num(kv.files),
    index: kv.index || null,
    phpSocket: kv.socket || null,
    siteUser: kv.siteUser || null,
    wwwCanon: s.canonFile ? kv.wwwCanon === '1' : null,
  };
}

/** Droits sudo du compte SSH (sortie de `sudo -n -l`). */
export function parseSudo(out) {
  const commands = new Set();
  let all = false;
  for (const m of out.matchAll(/NOPASSWD:\s*([^\n]+)/g)) {
    for (const part of m[1].split(',')) {
      const cmd = part.trim().split(/\s+/)[0];
      if (cmd === 'ALL') all = true;
      else if (cmd) commands.add(cmd);
    }
  }
  return { all, commands: [...commands] };
}

/** Une action est-elle disponible ? (commande configurée + sudo autorisé si nécessaire). */
export function capability(s, action, sudo) {
  if (action === 'lock' || action === 'unlock') return s.lockop?.[action] ? { ok: true } : { ok: false, reason: 'lockop_missing' };
  const tpl = s.commands?.[action];
  if (!tpl) return { ok: false, reason: 'not_configured' };
  const m = tpl.match(/^\s*sudo\s+(?:-\S+\s+)*(\S+)/);
  if (m && sudo && !sudo.all && !sudo.commands.includes(m[1])) return { ok: false, reason: 'sudo_denied' };
  return { ok: true };
}

export const isSudoDenied = (text) => /sudo: (a password is required|.*may not run sudo|.*not allowed to (execute|run))/i.test(text);

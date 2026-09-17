import zlib from 'node:zlib';

/**
 * Lecture / écriture d'archives ZIP en pur Node (zlib), sans binaire `zip`/`unzip`
 * côté serveur : les VPS du parc n'en disposent pas.
 *
 * Limites assumées (pas de ZIP64) : 65 535 fichiers, 4 Gio par fichier et par archive.
 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

export function crc32(buf, seed = 0) {
  let c = ~seed;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** Date/heure au format MS-DOS utilisé par le format ZIP. */
function dosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const deflate = (buf) => zlib.deflateRawSync(buf, { level: 6 });
const inflate = (buf, max) => zlib.inflateRawSync(buf, { maxOutputLength: max });

/**
 * Génère une archive ZIP morceau par morceau (un seul fichier en mémoire à la fois).
 * `entries` : itérable asynchrone de { name, isDir, mtime, data }.
 */
export async function* zipStream(entries) {
  const central = [];
  let offset = 0;
  let count = 0;
  const push = (buf) => {
    offset += buf.length;
    return buf;
  };

  for await (const entry of entries) {
    const name = entry.isDir && !entry.name.endsWith('/') ? `${entry.name}/` : entry.name;
    const nameBuf = Buffer.from(name, 'utf8');
    if (nameBuf.length > 0xffff) throw new Error(`Nom d'entrée trop long : ${name}`);
    const raw = entry.isDir ? Buffer.alloc(0) : entry.data;
    const { time, date } = dosDateTime(entry.mtime);
    const crc = entry.isDir ? 0 : crc32(raw);
    const compressed = entry.isDir || raw.length === 0 ? Buffer.alloc(0) : deflate(raw);
    const useDeflate = compressed.length > 0 && compressed.length < raw.length;
    const payload = useDeflate ? compressed : raw;
    const method = useDeflate ? 8 : 0;
    const headerOffset = offset;

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version minimale
    local.writeUInt16LE(0x0800, 6); // drapeau : noms en UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    yield push(local);
    if (payload.length) yield push(payload);

    const dir = Buffer.alloc(46 + nameBuf.length);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(0x031e, 4); // créé sous Unix
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(payload.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    // attributs externes : mode Unix (16 bits de poids fort) + attribut DOS 'dossier'
    dir.writeUInt32LE(((((entry.isDir ? 0o040755 : 0o100644) << 16) >>> 0) | (entry.isDir ? 0x10 : 0)) >>> 0, 38);
    dir.writeUInt32LE(headerOffset, 42);
    nameBuf.copy(dir, 46);
    central.push(dir);
    count++;
    if (count > 0xffff) throw new Error('Trop de fichiers pour une archive ZIP standard (65 535 max)');
  }

  const centralOffset = offset;
  for (const dir of central) yield push(dir);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(offset - centralOffset, 12);
  end.writeUInt32LE(centralOffset, 16);
  yield end;
}

/** Construit l'archive complète en mémoire (pour l'écrire ensuite sur le serveur). */
export async function zipToBuffer(entries) {
  const chunks = [];
  for await (const chunk of zipStream(entries)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Liste les entrées d'une archive à partir de son annuaire central.
 * Retourne { name, isDir, size, compressedSize, method, offset, mtime }.
 */
export function readZipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Archive ZIP invalide (fin d\'archive introuvable)');
  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) throw new Error('Archive ZIP invalide (annuaire central corrompu)');
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
    const externalAttrs = buf.readUInt32LE(pos + 38);
    const unixMode = externalAttrs >>> 16;
    entries.push({
      name,
      isDir: name.endsWith('/'),
      isSymlink: (unixMode & 0o170000) === 0o120000,
      method: buf.readUInt16LE(pos + 10),
      compressedSize: buf.readUInt32LE(pos + 20),
      size: buf.readUInt32LE(pos + 24),
      offset: buf.readUInt32LE(pos + 42),
    });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Extrait le contenu d'une entrée (le ratio de décompression est plafonné : anti « zip bomb »). */
export function extractEntry(buf, entry, maxSize) {
  if (entry.size > maxSize) throw new Error(`Entrée trop volumineuse : ${entry.name}`);
  const pos = entry.offset;
  if (pos + 30 > buf.length || buf.readUInt32LE(pos) !== 0x04034b50) throw new Error(`Entrée ZIP corrompue : ${entry.name}`);
  const nameLen = buf.readUInt16LE(pos + 26);
  const extraLen = buf.readUInt16LE(pos + 28);
  const start = pos + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compressedSize);
  const out = entry.method === 0 ? Buffer.from(raw) : inflate(raw, maxSize);
  if (out.length !== entry.size) throw new Error(`Taille inattendue pour ${entry.name}`);
  return out;
}

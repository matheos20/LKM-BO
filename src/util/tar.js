/**
 * Lecture / écriture de flux TAR (ustar + extension GNU « L » pour les noms longs).
 *
 * Sert de transport entre les serveurs et l'application : une arborescence entière voyage
 * en UN seul aller-retour SSH (`tar -cf -` / `tar -xf -`), là où un transfert fichier par
 * fichier coûterait environ une seconde par fichier sur ces liaisons.
 */
const BLOCK = 512;
const pad = (n) => (n % BLOCK === 0 ? 0 : BLOCK - (n % BLOCK));
const octal = (value, len) => value.toString(8).padStart(len - 1, '0') + '\0';

function header({ name, size = 0, mode = 0o644, mtime = new Date(), type = '0' }) {
  const buf = Buffer.alloc(BLOCK);
  buf.write(name.slice(0, 100), 0, 100, 'utf8');
  buf.write(octal(mode & 0o7777, 8), 100, 8, 'ascii');
  buf.write(octal(0, 8), 108, 8, 'ascii');
  buf.write(octal(0, 8), 116, 8, 'ascii');
  buf.write(octal(size, 12), 124, 12, 'ascii');
  buf.write(octal(Math.floor((mtime instanceof Date ? mtime.getTime() : mtime) / 1000), 12), 136, 12, 'ascii');
  buf.write('        ', 148, 8, 'ascii'); // somme de contrôle : espaces pendant le calcul
  buf.write(type, 156, 1, 'ascii');
  buf.write('ustar\0', 257, 6, 'ascii');
  buf.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(octal(sum, 7) + ' ', 148, 8, 'ascii');
  return buf;
}

/** Écrit un flux TAR à partir d'entrées { name, isDir, mtime, mode, data }. */
export async function* tarStream(entries) {
  for await (const entry of entries) {
    const isDir = Boolean(entry.isDir);
    const name = isDir && !entry.name.endsWith('/') ? entry.name + '/' : entry.name;
    const nameBuf = Buffer.from(name, 'utf8');

    if (nameBuf.length > 100) {
      // Nom long : bloc GNU LongLink, puis l'entrée réelle.
      const payload = Buffer.concat([nameBuf, Buffer.from([0])]);
      yield header({ name: '././@LongLink', size: payload.length, type: 'L', mode: 0 });
      yield payload;
      if (pad(payload.length)) yield Buffer.alloc(pad(payload.length));
    }

    const data = isDir ? Buffer.alloc(0) : entry.data;
    yield header({ name, size: data.length, mode: entry.mode ?? (isDir ? 0o755 : 0o644), mtime: entry.mtime, type: isDir ? '5' : '0' });
    if (data.length) {
      yield data;
      if (pad(data.length)) yield Buffer.alloc(pad(data.length));
    }
  }
  yield Buffer.alloc(BLOCK * 2); // fin d'archive
}

const readStr = (buf, off, len) => {
  const end = buf.indexOf(0, off);
  return buf.toString('utf8', off, end >= 0 && end < off + len ? end : off + len).trim();
};
const readOct = (buf, off, len) => parseInt(readStr(buf, off, len) || '0', 8) || 0;

/**
 * Analyse un flux TAR au fil de l'eau (itérable asynchrone de Buffers) : seuls l'entrée
 * courante et le reliquat du tampon sont en mémoire.
 * `maxBytes` et `maxEntries` bornent ce qui est accepté.
 */
export async function* parseTar(source, { maxBytes = Infinity, maxEntries = 20000 } = {}) {
  let buf = Buffer.alloc(0);
  let longName = null;
  let total = 0;
  let count = 0;

  for await (const chunk of source) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;

    for (;;) {
      if (buf.length < BLOCK) break;
      const head = buf.subarray(0, BLOCK);
      if (head.every((b) => b === 0)) return; // fin d'archive

      const size = readOct(head, 124, 12);
      const needed = BLOCK + size + pad(size);
      if (buf.length < needed) break; // il manque des octets : on attend la suite du flux

      const type = String.fromCharCode(head[156]) || '0';
      const prefix = readStr(head, 345, 155);
      let name = readStr(head, 0, 100);
      if (prefix) name = prefix + '/' + name;
      const data = buf.subarray(BLOCK, BLOCK + size);
      buf = buf.subarray(needed);

      if (type === 'L') {
        longName = data.toString('utf8').replace(/\0+$/, '');
        continue;
      }
      if (longName) {
        name = longName;
        longName = null;
      }
      if (type !== '0' && type !== '\0' && type !== '5') continue; // ni lien symbolique, ni périphérique

      total += size;
      if (total > maxBytes) throw new Error('Archive trop volumineuse');
      if (++count > maxEntries) throw new Error("Trop d'entrées dans l'archive");

      yield {
        name: name.replace(/\/+$/, ''),
        isDir: type === '5',
        size,
        mode: readOct(head, 100, 8),
        mtime: new Date(readOct(head, 136, 12) * 1000),
        data: type === '5' ? Buffer.alloc(0) : Buffer.from(data),
      };
    }
  }
}

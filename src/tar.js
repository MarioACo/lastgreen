// Streaming tar / tar.gz extractor with no dependencies.
// Used for npm package tarballs and official Node.js builds. It refuses
// absolute paths and ".." so a hostile tarball cannot write outside `dest`,
// and it skips links and devices (npm never publishes them).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export async function extractTarball(file, dest, options = {}) {
  const head = Buffer.alloc(2);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, head, 0, 2, 0);
  } finally {
    fs.closeSync(fd);
  }
  const gzip = head[0] === 0x1f && head[1] === 0x8b;
  const extractor = new TarExtractor(dest, options);
  const source = fs.createReadStream(file);
  if (gzip) await pipeline(source, zlib.createGunzip(), extractor);
  else await pipeline(source, extractor);
  return extractor.written;
}

function cstr(buf, start, length) {
  const slice = buf.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
}

function octal(buf, start, length) {
  const text = cstr(buf, start, length).trim();
  return text ? parseInt(text, 8) : 0;
}

function numeric(buf, start, length) {
  if (buf[start] & 0x80) {
    // GNU base-256 encoding for large sizes
    let value = 0;
    for (let i = start + 1; i < start + length; i++) value = value * 256 + buf[i];
    return value;
  }
  return octal(buf, start, length);
}

function checksumOk(header) {
  const stored = octal(header, 148, 8);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
  return stored === sum;
}

function parsePax(buf) {
  const out = {};
  let i = 0;
  while (i < buf.length) {
    const space = buf.indexOf(32, i);
    if (space === -1) break;
    const len = parseInt(buf.subarray(i, space).toString(), 10);
    if (!len) break;
    const record = buf.subarray(space + 1, i + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += len;
  }
  return out;
}

class TarExtractor extends Writable {
  constructor(dest, { strip = 1, filter = null } = {}) {
    super();
    this.dest = path.resolve(dest);
    this.strip = strip;
    this.filter = filter;
    this.buf = Buffer.alloc(0);
    this.state = 'header';
    this.remaining = 0;
    this.padding = 0;
    this.entry = null;
    this.pax = null;
    this.longName = null;
    this.written = [];
    fs.mkdirSync(this.dest, { recursive: true });
  }

  _write(chunk, _encoding, callback) {
    try {
      this.feed(chunk);
      callback();
    } catch (err) {
      this.closeEntry();
      callback(err);
    }
  }

  _final(callback) {
    this.closeEntry();
    if (this.state === 'data') return callback(new Error('tar: archive is truncated'));
    callback();
  }

  feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let off = 0;
    for (;;) {
      if (this.state === 'done') {
        off = this.buf.length;
        break;
      }
      if (this.state === 'header') {
        if (this.buf.length - off < 512) break;
        const header = this.buf.subarray(off, off + 512);
        off += 512;
        this.header(header);
      } else if (this.state === 'data') {
        const n = Math.min(this.remaining, this.buf.length - off);
        if (n === 0) break;
        this.data(this.buf.subarray(off, off + n));
        off += n;
        this.remaining -= n;
        if (this.remaining === 0) {
          this.finishEntry();
          this.state = this.padding ? 'pad' : 'header';
        }
      } else {
        const n = Math.min(this.padding, this.buf.length - off);
        if (n === 0) break;
        off += n;
        this.padding -= n;
        if (this.padding === 0) this.state = 'header';
      }
    }
    this.buf = this.buf.subarray(off);
  }

  header(h) {
    if (h.every((b) => b === 0)) {
      this.state = 'done';
      return;
    }
    if (!checksumOk(h)) throw new Error('tar: bad header checksum (corrupt archive)');
    const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
    const magic = cstr(h, 257, 6);
    const prefix = magic.startsWith('ustar') ? cstr(h, 345, 155) : '';
    let name = cstr(h, 0, 100);
    if (prefix) name = `${prefix}/${name}`;
    let size = numeric(h, 124, 12);
    const mode = octal(h, 100, 8);

    if (type === 'x' || type === 'g' || type === 'L' || type === 'K') {
      this.entry = { meta: type, chunks: [] };
    } else {
      if (this.longName != null) name = this.longName;
      if (this.pax?.path) name = this.pax.path;
      if (this.pax?.size) size = Number(this.pax.size);
      this.longName = null;
      this.pax = null;
      this.entry = this.openEntry(type, name, mode);
    }
    this.remaining = size;
    this.padding = (512 - (size % 512)) % 512;
    if (size === 0) {
      this.finishEntry();
      this.state = 'header';
    } else {
      this.state = 'data';
    }
  }

  target(name) {
    if (name.startsWith('/') || name.startsWith('\\') || /^[a-zA-Z]:/.test(name)) {
      throw new Error(`tar: refusing absolute path "${name}"`);
    }
    const parts = name.split(/[\\/]+/).filter((p) => p && p !== '.');
    if (parts.includes('..')) throw new Error(`tar: refusing path with ".." ("${name}")`);
    const rel = parts.slice(this.strip);
    if (!rel.length) return null;
    const relPath = rel.join('/');
    if (this.filter && !this.filter(relPath)) return null;
    const out = path.join(this.dest, ...rel);
    if (!out.startsWith(this.dest + path.sep)) throw new Error(`tar: refusing path "${name}"`);
    return { out, rel: relPath };
  }

  openEntry(type, name, mode) {
    const isFile = type === '0' || type === '7';
    const isDir = type === '5';
    if (!isFile && !isDir) return { skip: true };
    const target = this.target(name);
    if (!target) return { skip: true };
    if (isDir) {
      fs.mkdirSync(target.out, { recursive: true });
      return { skip: true };
    }
    fs.mkdirSync(path.dirname(target.out), { recursive: true });
    const fileMode = ((mode & 0o755) | 0o644) & 0o777;
    const fd = fs.openSync(target.out, 'w', fileMode);
    this.written.push(target.rel);
    return { fd, out: target.out, mode: fileMode };
  }

  data(chunk) {
    const entry = this.entry;
    if (!entry || entry.skip) return;
    if (entry.meta) entry.chunks.push(Buffer.from(chunk));
    else fs.writeSync(entry.fd, chunk);
  }

  finishEntry() {
    const entry = this.entry;
    this.entry = null;
    if (!entry || entry.skip) return;
    if (entry.meta) {
      const body = Buffer.concat(entry.chunks);
      if (entry.meta === 'x') this.pax = parsePax(body);
      else if (entry.meta === 'L') this.longName = cstr(body, 0, body.length);
      return;
    }
    fs.closeSync(entry.fd);
    if (process.platform !== 'win32') fs.chmodSync(entry.out, entry.mode);
  }

  closeEntry() {
    if (this.entry?.fd != null) {
      try {
        fs.closeSync(this.entry.fd);
      } catch {}
    }
    this.entry = null;
  }
}

/**
 * A validating `.tar.gz` extractor for the snapshot artifact (C-3, C-4).
 *
 * The review job holds the model key and the write token, and the archive
 * holds PR-controlled files, so extraction is done here rather than by
 * `tar`, with every rule explicit:
 *
 * - Only regular files, directories and symbolic links. Hard links,
 *   devices, FIFOs and anything unknown fail the extraction.
 * - Member paths are relative, have no `..` segment, and their first
 *   segment is one of the allowed top-level names.
 * - Nothing is written through a symbolic link: every parent of a member
 *   must be a real directory this extraction created or found, and files
 *   are opened with O_EXCL, so an existing entry (including a planted
 *   symlink) is never overwritten. Duplicate members fail the extraction.
 * - Symbolic links are created as they are, whatever they point at. They
 *   are data; the agent's guard resolves them and rejects anything outside
 *   the snapshot roots (C-3).
 * - Files are created read-only (0444), never executable; modes, owners and
 *   times in the archive are ignored.
 * - Total size and member count are capped.
 *
 * Understands ustar, POSIX pax (`x` headers for long paths and sizes; `g`
 * ignored) and GNU long names (`L`, `K`), which covers GNU tar and bsdtar.
 */
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, symlinkSync, writeSync } from "node:fs";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { createGunzip } from "node:zlib";

export interface UnpackOptions {
  /** Allowed first path segments. Default: anything. */
  allowedTop?: readonly string[];
  /** Cap on the sum of file sizes. Default 16 GiB. */
  maxBytes?: number;
  /** Cap on the number of members. Default 2 million. */
  maxEntries?: number;
}

export interface UnpackStats {
  files: number;
  dirs: number;
  symlinks: number;
  bytes: number;
}

export class UnsafeArchiveError extends Error {
  override name = "UnsafeArchiveError";
}

const BLOCK = 512;

/** Reads exact byte counts from a stream of chunks. */
class ByteReader {
  private readonly it: AsyncIterator<Buffer>;
  private buf: Buffer = Buffer.alloc(0);
  private done = false;
  constructor(stream: AsyncIterable<Buffer>) {
    this.it = stream[Symbol.asyncIterator]();
  }

  private async fill(n: number): Promise<void> {
    while (this.buf.length < n && !this.done) {
      const r = await this.it.next();
      if (r.done) this.done = true;
      else this.buf = this.buf.length === 0 ? r.value : Buffer.concat([this.buf, r.value]);
    }
  }

  /** Exactly `n` bytes, or undefined at a clean end of stream. */
  async read(n: number): Promise<Buffer | undefined> {
    await this.fill(n);
    if (this.buf.length === 0 && this.done) return undefined;
    if (this.buf.length < n) throw new UnsafeArchiveError("archive is truncated");
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  /** Streams `n` bytes to `sink` in chunks. */
  async pipe(n: number, sink: (chunk: Buffer) => void): Promise<void> {
    let left = n;
    while (left > 0) {
      if (this.buf.length === 0) await this.fill(1);
      if (this.buf.length === 0) throw new UnsafeArchiveError("archive is truncated");
      const take = Math.min(left, this.buf.length);
      sink(this.buf.subarray(0, take));
      this.buf = this.buf.subarray(take);
      left -= take;
    }
  }

  async skip(n: number): Promise<void> {
    await this.pipe(n, () => {});
  }
}

function cString(b: Buffer): string {
  const nul = b.indexOf(0);
  return (nul === -1 ? b : b.subarray(0, nul)).toString("utf8");
}

function parseNumber(field: Buffer): number {
  if ((field[0]! & 0x80) !== 0) {
    // GNU base-256: big-endian, first byte's high bit is the marker.
    let v = field[0]! & 0x7f;
    for (let i = 1; i < field.length; i++) v = v * 256 + field[i]!;
    if (!Number.isSafeInteger(v)) throw new UnsafeArchiveError("member size is too large");
    return v;
  }
  const s = cString(field).trim();
  if (s === "") return 0;
  if (!/^[0-7]+$/.test(s)) throw new UnsafeArchiveError(`bad numeric field "${s}"`);
  return parseInt(s, 8);
}

function checksumOk(h: Buffer): boolean {
  const stored = parseNumber(h.subarray(148, 156));
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
  return sum === stored;
}

function parsePax(data: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp === -1) break;
    const len = Number(data.subarray(i, sp).toString("ascii"));
    if (!Number.isSafeInteger(len) || len <= 0 || i + len > data.length) throw new UnsafeArchiveError("bad pax header");
    const record = data.subarray(sp + 1, i + len - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0) out.set(record.slice(0, eq), record.slice(eq + 1));
    i += len;
  }
  return out;
}

/** Normalized relative segments, or an error for anything unsafe. */
export function safeSegments(name: string, allowedTop?: readonly string[]): string[] {
  if (name.includes("\0")) throw new UnsafeArchiveError(`member name contains NUL: ${JSON.stringify(name)}`);
  if (name.startsWith("/")) throw new UnsafeArchiveError(`absolute member path: ${name}`);
  const segs = name.split("/").filter((s) => s !== "" && s !== ".");
  if (segs.includes("..")) throw new UnsafeArchiveError(`member path with "..": ${name}`);
  if (segs.length === 0) return segs;
  if (allowedTop !== undefined && !allowedTop.includes(segs[0]!)) throw new UnsafeArchiveError(`unexpected top-level entry: ${segs[0]}`);
  return segs;
}

/**
 * Makes sure `dest/segs[0..n]` are real directories, creating them as
 * needed. Refuses a symlink or a non-directory anywhere on the way.
 */
function ensureDirs(dest: string, segs: readonly string[]): number {
  let created = 0;
  let current = dest;
  for (const s of segs) {
    current = join(current, s);
    let st;
    try {
      st = lstatSync(current);
    } catch {
      st = undefined;
    }
    if (st === undefined) {
      mkdirSync(current, { mode: 0o755 });
      created++;
    } else if (st.isSymbolicLink()) {
      throw new UnsafeArchiveError(`member would be written through a symbolic link: ${segs.join("/")}`);
    } else if (!st.isDirectory()) {
      throw new UnsafeArchiveError(`member would be written below a non-directory: ${segs.join("/")}`);
    }
  }
  return created;
}

/** Extracts `archive` (gzip-compressed tar) into the empty or missing directory `dest`. */
export async function unpackTarGz(archive: string, dest: string, o: UnpackOptions = {}): Promise<UnpackStats> {
  const maxBytes = o.maxBytes ?? 16 * 1024 ** 3;
  const maxEntries = o.maxEntries ?? 2_000_000;
  if (existsSync(dest)) {
    if (readdirSync(dest).length > 0) throw new Error(`destination ${dest} is not empty`);
  } else {
    mkdirSync(dest, { recursive: true, mode: 0o755 });
  }

  // A read error (missing file) must reject the iteration, not crash the process.
  const gunzip = createGunzip();
  const file = createReadStream(archive);
  file.on("error", (e) => gunzip.destroy(e));
  const reader = new ByteReader(file.pipe(gunzip));
  const stats: UnpackStats = { files: 0, dirs: 0, symlinks: 0, bytes: 0 };
  const seen = new Set<string>();
  let entries = 0;
  let pax = new Map<string, string>();
  let longName: string | undefined;
  let longLink: string | undefined;

  for (;;) {
    const h = await reader.read(BLOCK);
    if (h === undefined) break; // no end-of-archive blocks; tolerated like tar does
    if (h.every((b) => b === 0)) break; // end of archive
    if (!checksumOk(h)) throw new UnsafeArchiveError("bad header checksum (not a tar archive, or corrupt)");
    if (++entries > maxEntries) throw new UnsafeArchiveError(`more than ${maxEntries} members`);

    const type = String.fromCharCode(h[156]!);
    let size = parseNumber(h.subarray(124, 136));
    const padded = (n: number) => Math.ceil(n / BLOCK) * BLOCK;

    // Metadata members describe the next one.
    if (type === "x" || type === "g" || type === "L" || type === "K") {
      if (size > 1024 * 1024) throw new UnsafeArchiveError("oversized metadata header");
      const data = (await reader.read(padded(size)))?.subarray(0, size) ?? Buffer.alloc(0);
      if (type === "x") pax = parsePax(data);
      else if (type === "L") longName = cString(data);
      else if (type === "K") longLink = cString(data);
      continue;
    }

    const magic = h.subarray(257, 262).toString("ascii");
    const prefix = magic === "ustar" ? cString(h.subarray(345, 500)) : "";
    let name = longName ?? pax.get("path") ?? (prefix !== "" ? `${prefix}/${cString(h.subarray(0, 100))}` : cString(h.subarray(0, 100)));
    const linkName = longLink ?? pax.get("linkpath") ?? cString(h.subarray(157, 257));
    const paxSize = pax.get("size");
    if (paxSize !== undefined) {
      if (!/^\d+$/.test(paxSize)) throw new UnsafeArchiveError("bad pax size");
      size = Number(paxSize);
    }
    pax = new Map();
    longName = undefined;
    longLink = undefined;

    if (type === "5") name = name.replace(/\/+$/, "");
    const segs = safeSegments(name, o.allowedTop);
    if (segs.length === 0) {
      // "./" itself.
      if (type !== "5") throw new UnsafeArchiveError(`unnamed member of type ${type}`);
      await reader.skip(padded(size));
      continue;
    }
    const rel = segs.join("/");
    const target = join(dest, ...segs);

    if (type === "5") {
      stats.dirs += ensureDirs(dest, segs);
      await reader.skip(padded(size));
      continue;
    }
    if (seen.has(rel)) throw new UnsafeArchiveError(`duplicate member: ${rel}`);
    seen.add(rel);

    if (type === "2") {
      stats.dirs += ensureDirs(dest, segs.slice(0, -1));
      if (linkName === "") throw new UnsafeArchiveError(`symbolic link without a target: ${rel}`);
      symlinkSync(linkName, target); // fails if anything already exists there
      stats.symlinks++;
      await reader.skip(padded(size));
      continue;
    }
    if (type === "0" || type === "\0" || type === "7") {
      stats.bytes += size;
      if (stats.bytes > maxBytes) throw new UnsafeArchiveError(`archive expands to more than ${maxBytes} bytes`);
      stats.dirs += ensureDirs(dest, segs.slice(0, -1));
      const fd = openSync(target, "wx", 0o444);
      try {
        await reader.pipe(size, (chunk) => {
          let off = 0;
          while (off < chunk.length) off += writeSync(fd, chunk, off, chunk.length - off);
        });
      } finally {
        closeSync(fd);
      }
      await reader.skip(padded(size) - size);
      stats.files++;
      continue;
    }
    const kinds: Record<string, string> = { "1": "hard link", "3": "character device", "4": "block device", "6": "FIFO" };
    throw new UnsafeArchiveError(`${kinds[type] ?? `member type "${type}"`} is not allowed: ${rel}`);
  }
  return stats;
}

/** The validating snapshot extractor (C-3, C-4). */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { gzipSync } from "node:zlib";
import { safeSegments, unpackTarGz, UnsafeArchiveError } from "./tar.ts";

const work = realpathSync(mkdtempSync(join(tmpdir(), "review-bot-tar-")));
after(() => rmSync(work, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(work, `t${n++}`);

interface Entry {
  name: string;
  type?: string;
  data?: string;
  link?: string;
  /** Emit a pax header carrying the name (for long paths). */
  pax?: boolean;
  /** Emit a GNU 'L' long-name header. */
  gnuLong?: boolean;
}

function header(name: string, type: string, size: number, link = ""): Buffer {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, "utf8");
  h.write("0000644\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(size.toString(8).padStart(11, "0") + "\0", 124);
  h.write("00000000000\0", 136);
  h.write(type, 156);
  h.write(link.slice(0, 100), 157);
  h.write("ustar\0", 257);
  h.write("00", 263);
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}

function pad(b: Buffer): Buffer {
  const r = b.length % 512;
  return r === 0 ? b : Buffer.concat([b, Buffer.alloc(512 - r)]);
}

function tarGz(entries: Entry[]): string {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? "");
    if (e.pax) {
      const rec = (k: string, v: string) => {
        const body = ` ${k}=${v}\n`;
        let len = body.length + 1;
        while (`${len}${body}`.length !== len) len = `${len}${body}`.length;
        return `${len}${body}`;
      };
      const pax = Buffer.from(rec("path", e.name) + (e.link ? rec("linkpath", e.link) : ""));
      parts.push(header("PaxHeader", "x", pax.length), pad(pax));
    }
    if (e.gnuLong) {
      const ln = Buffer.from(e.name + "\0");
      parts.push(header("././@LongLink", "L", ln.length), pad(ln));
    }
    const type = e.type ?? "0";
    parts.push(header(e.pax || e.gnuLong ? "short-name-ignored" : e.name, type, type === "0" ? data.length : 0, e.link ?? ""));
    if (type === "0") parts.push(pad(data));
  }
  parts.push(Buffer.alloc(1024));
  const file = join(work, `a${n++}.tar.gz`);
  writeFileSync(file, gzipSync(Buffer.concat(parts)));
  return file;
}

const TOP = ["manifest.json", "base", "head", "modcache"];

test("files, directories, symlinks, pax and GNU long names", async () => {
  const long = `modcache/${"k8s.io/".repeat(20)}api@v0.31.0/core/v1/types.go`;
  const dest = fresh();
  const stats = await unpackTarGz(
    tarGz([
      { name: "head/", type: "5" },
      { name: "head/main.go", data: "package main\n" },
      { name: "head/link", type: "2", link: "../../../etc/passwd" },
      { name: long, data: "package v1\n", pax: true },
      { name: `base/${"x".repeat(150)}.go`, data: "package x\n", gnuLong: true },
      { name: "./manifest.json", data: "{}" },
    ]),
    dest,
    { allowedTop: TOP },
  );
  assert.deepEqual([stats.files, stats.symlinks], [4, 1]);
  assert.equal(readFileSync(join(dest, "head", "main.go"), "utf8"), "package main\n");
  assert.equal(readFileSync(join(dest, long), "utf8"), "package v1\n");
  assert.equal(readFileSync(join(dest, "base", `${"x".repeat(150)}.go`), "utf8"), "package x\n");
  // Symlinks are data: created as they are, never followed here.
  assert.equal(readlinkSync(join(dest, "head", "link")), "../../../etc/passwd");
  // Files are read-only and not executable.
  assert.equal(statSync(join(dest, "head", "main.go")).mode & 0o777, 0o444);
});

const unsafe: Array<[string, Entry[], RegExp]> = [
  ["parent segment", [{ name: "head/../../escape", data: "x" }], /\.\./],
  ["absolute path", [{ name: "/tmp/escape", data: "x" }], /absolute/],
  ["unexpected top level", [{ name: ".github/workflows/x.yml", data: "x" }], /top-level/],
  ["write through a symlinked dir", [{ name: "head/d", type: "2", link: "/tmp" }, { name: "head/d/evil", data: "x" }], /symbolic link/],
  ["write through a symlink via pax path", [{ name: "head/d", type: "2", link: ".." }, { name: "head/d/evil", data: "x", pax: true }], /symbolic link/],
  ["file replaced by later symlink", [{ name: "head/f", data: "x" }, { name: "head/f", type: "2", link: "/etc/passwd" }], /duplicate/],
  ["duplicate file", [{ name: "head/f", data: "x" }, { name: "head/f", data: "y" }], /duplicate/],
  ["hard link", [{ name: "head/f", data: "x" }, { name: "head/h", type: "1", link: "head/f" }], /hard link/],
  ["device", [{ name: "head/dev", type: "3" }], /character device/],
  ["fifo", [{ name: "head/p", type: "6" }], /FIFO/],
  ["below a file", [{ name: "head/f", data: "x" }, { name: "head/f/g", data: "y" }], /non-directory/],
];

for (const [what, entries, message] of unsafe) {
  test(`refuses: ${what}`, async () => {
    await assert.rejects(unpackTarGz(tarGz(entries), fresh(), { allowedTop: TOP }), (e: Error) => {
      assert.ok(e instanceof UnsafeArchiveError, e.message);
      assert.match(e.message, message);
      return true;
    });
  });
}

test("a symlink planted inside the destination is never written through", async () => {
  const outside = fresh();
  mkdirSync(outside);
  await assert.rejects(unpackTarGz(tarGz([{ name: "head/x", type: "2", link: outside }, { name: "head/x/owned", data: "x" }]), fresh()), /symbolic link/);
  assert.equal(existsSync(join(outside, "owned")), false);
});

test("size and member caps", async () => {
  await assert.rejects(unpackTarGz(tarGz([{ name: "head/big", data: "x".repeat(2000) }]), fresh(), { maxBytes: 1000 }), /more than 1000 bytes/);
  await assert.rejects(unpackTarGz(tarGz([{ name: "head/a", data: "" }, { name: "head/b", data: "" }]), fresh(), { maxEntries: 1 }), /more than 1 members/);
});

test("not a tar archive, truncated archive, non-empty destination", async () => {
  const junk = join(work, "junk.tar.gz");
  writeFileSync(junk, gzipSync(Buffer.alloc(512, 7)));
  await assert.rejects(unpackTarGz(junk, fresh()), /checksum|numeric field/);
  const full = readFileSync(tarGz([{ name: "head/a", data: "x".repeat(3000) }]));
  const cut = join(work, "cut.tar.gz");
  const { gunzipSync } = await import("node:zlib");
  writeFileSync(cut, gzipSync(gunzipSync(full).subarray(0, 1500)));
  await assert.rejects(unpackTarGz(cut, fresh()), /truncated/);
  const busy = fresh();
  mkdirSync(busy);
  writeFileSync(join(busy, "x"), "");
  await assert.rejects(unpackTarGz(tarGz([]), busy), /not empty/);
});

test("reads what the system tar writes (long paths, symlinks, nested dirs)", async () => {
  const src = fresh();
  const deep = join(src, "modcache", ...Array.from({ length: 12 }, (_, i) => `segment-number-${i}`));
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(deep, "file.go"), "package deep\n");
  mkdirSync(join(src, "head", "pkg"), { recursive: true });
  writeFileSync(join(src, "head", "pkg", "a.go"), "package pkg\n");
  symlinkSync("pkg/a.go", join(src, "head", "alias.go"));
  writeFileSync(join(src, "manifest.json"), "{}");
  mkdirSync(join(src, "base"));
  const archive = join(work, "system.tar.gz");
  // COPYFILE_DISABLE: no AppleDouble "._" members from macOS bsdtar.
  execFileSync("tar", ["-czf", archive, "-C", src, "manifest.json", "base", "head", "modcache"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const dest = fresh();
  await unpackTarGz(archive, dest, { allowedTop: TOP });
  assert.equal(readFileSync(join(dest, "modcache", ...Array.from({ length: 12 }, (_, i) => `segment-number-${i}`), "file.go"), "utf8"), "package deep\n");
  assert.ok(lstatSync(join(dest, "head", "alias.go")).isSymbolicLink());
  assert.equal(readFileSync(join(dest, "head", "alias.go"), "utf8"), "package pkg\n");
});

test("safeSegments normalizes ./ and empty segments", () => {
  assert.deepEqual(safeSegments("./head//a/./b"), ["head", "a", "b"]);
  assert.deepEqual(safeSegments("./"), []);
  assert.throws(() => safeSegments("head/a\0b"), /NUL/);
});

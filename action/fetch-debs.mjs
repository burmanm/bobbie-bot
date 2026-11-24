// Downloads the pinned Debian packages listed in debs.json for this
// architecture into a directory (F-7, R-1a step 6: git for `review-bot
// setup`). Runs at image build time only. Every file is checked against its
// pinned SHA-256 before it is written; a mismatch fails the build. The
// Dockerfile installs them with dpkg in the final stage.
//
//   node fetch-debs.mjs <debs.json> <dir>
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [manifestPath, outDir] = process.argv.slice(2);
if (!manifestPath || !outDir) {
  console.error("usage: node fetch-debs.mjs <debs.json> <dir>");
  process.exit(2);
}
const arch = process.arch; // "x64" or "arm64"
const { debs } = JSON.parse(readFileSync(manifestPath, "utf8"));
const list = debs[arch];
if (!Array.isArray(list) || list.length === 0) throw new Error(`no pinned packages for ${arch}`);
mkdirSync(outDir, { recursive: true });

for (const [i, deb] of list.entries()) {
  if (!/^[0-9a-f]{64}$/.test(deb.sha256)) throw new Error(`${deb.name}: bad sha256`);
  if (!/^https:\/\/snapshot\.debian\.org\/archive\/debian(-security)?\/\d{8}T\d{6}Z\/pool\/[^?#]+\.deb$/.test(deb.url)) throw new Error(`${deb.name}: not a snapshot.debian.org URL: ${deb.url}`);
  if (!/^[a-z0-9][a-z0-9.+-]*$/.test(deb.name)) throw new Error(`bad package name: ${deb.name}`);
  const res = await fetch(deb.url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${deb.name}: download failed: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== deb.sha256) throw new Error(`${deb.name} ${deb.version}: SHA-256 mismatch: got ${digest}, pinned ${deb.sha256}`);
  writeFileSync(join(outDir, `${String(i).padStart(3, "0")}-${deb.name}.deb`), bytes);
  console.log(`fetched ${deb.name} ${deb.version} (sha256 ${digest})`);
}

// Installs the pinned search binaries listed in tools.json into a directory
// (C-3a). Runs at image build time only. Every download is checked against
// its pinned SHA-256 before anything is extracted; a mismatch fails the
// build.
//
//   node install-tools.mjs <tools.json> <bin dir>
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [manifestPath, binDir] = process.argv.slice(2);
if (!manifestPath || !binDir) {
  console.error("usage: node install-tools.mjs <tools.json> <bin dir>");
  process.exit(2);
}
const arch = process.arch; // "x64" or "arm64"
const { tools } = JSON.parse(readFileSync(manifestPath, "utf8"));
mkdirSync(binDir, { recursive: true });

for (const tool of tools) {
  const asset = tool.assets[arch];
  if (!asset) throw new Error(`${tool.name} ${tool.version}: no pinned asset for ${arch}`);
  if (!/^[0-9a-f]{64}$/.test(asset.sha256)) throw new Error(`${tool.name}: bad sha256`);
  const res = await fetch(asset.url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${tool.name}: download failed: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== asset.sha256) throw new Error(`${tool.name} ${tool.version}: SHA-256 mismatch: got ${digest}, pinned ${asset.sha256}`);
  const work = mkdtempSync(join(tmpdir(), `${tool.name}-`));
  try {
    const archive = join(work, "asset.tar.gz");
    writeFileSync(archive, bytes);
    execFileSync("tar", ["-xzf", archive, "-C", work, "--no-same-owner", asset.member], { stdio: "inherit" });
    const target = join(binDir, tool.name);
    copyFileSync(join(work, asset.member), target);
    chmodSync(target, 0o755);
    const version = execFileSync(target, ["--version"], { encoding: "utf8" }).split("\n")[0];
    if (!version.includes(tool.version)) throw new Error(`${tool.name}: expected version ${tool.version}, got "${version}"`);
    console.log(`installed ${target}: ${version} (sha256 ${digest})`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

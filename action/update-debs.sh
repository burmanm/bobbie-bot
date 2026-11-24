#!/usr/bin/env bash
# Regenerates action/debs.json: git and the Debian packages it needs that the
# pinned base image lacks, for amd64 and arm64 (F-7, R-1a step 6: `review-bot
# setup` clones git package sources). Maintainer tool, run by hand; needs
# Docker and network. Never run by the action.
#
#   action/update-debs.sh [<snapshot timestamp, e.g. 20261123T000000Z>]
#
# For each architecture it asks apt in the base image which packages
# `apt-get install --no-install-recommends git` would add, takes each one's
# SHA-256 from Debian's signed package index, downloads the same file from
# snapshot.debian.org at the given timestamp (a URL that does not change) and
# checks that the bytes match. The output names those snapshot URLs and
# hashes; the image build checks the hashes again (action/fetch-debs.mjs).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
base="$(grep -m1 -oE 'node:[^ ]+@sha256:[0-9a-f]{64}' "$here/Dockerfile")"
ts="${1:-$(date -u +%Y%m%dT000000Z)}"
[[ "$ts" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || { echo "bad timestamp: $ts" >&2; exit 2; }

probe='
set -euo pipefail
apt-get update -qq >/dev/null
apt-get install -qq --print-uris --no-install-recommends git | while read -r url file size _; do
  url="${url:1:${#url}-2}"
  pkg="${file%%_*}"
  rest="${file#*_}"
  ver="$(sed "s/%3[aA]/:/g" <<< "${rest%_*}")"
  sha="$(apt-cache show --no-all-versions "$pkg=$ver" | sed -n "s/^SHA256: //p" | head -n1)"
  [[ "$sha" =~ ^[0-9a-f]{64}$ ]] || { echo "no SHA256 for $pkg=$ver" >&2; exit 1; }
  case "$url" in
    http://deb.debian.org/debian-security/*) snap="https://snapshot.debian.org/archive/debian-security/$TS/${url#http://deb.debian.org/debian-security/}" ;;
    http://deb.debian.org/debian/*) snap="https://snapshot.debian.org/archive/debian/$TS/${url#http://deb.debian.org/debian/}" ;;
    *) echo "unexpected source: $url" >&2; exit 1 ;;
  esac
  printf "%s %s %s %s\n" "$pkg" "$ver" "$sha" "$snap"
done
'

check='
const { createHash } = require("node:crypto");
const lines = require("node:fs").readFileSync(0, "utf8").trim().split("\n");
(async () => {
  const out = [];
  for (const line of lines) {
    const [name, version, sha256, url] = line.split(" ");
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const got = createHash("sha256").update(Buffer.from(await res.arrayBuffer())).digest("hex");
    if (got !== sha256) throw new Error(`${url}: SHA-256 ${got}, Debian index ${sha256}`);
    out.push({ name, version, url, sha256 });
  }
  process.stdout.write(JSON.stringify(out));
})().catch((e) => { console.error(e.message); process.exit(1); });
'

resolve() {
  echo "resolving $1" >&2
  docker run --rm --platform "linux/$1" -e TS="$ts" "$base" bash -c "$probe" | node -e "$check"
}
amd64="$(resolve amd64)"
arm64="$(resolve arm64)"

node -e '
const [amd64, arm64, ts, base] = process.argv.slice(1);
const doc = {
  comment: `git for review-bot setup (F-7: git package sources), with the Debian packages it needs that the base image lacks. Installed with dpkg at image build time from these snapshot.debian.org URLs (snapshot ${ts}), each checked against its SHA-256 from the signed Debian package index by action/update-debs.sh and again at build by action/fetch-debs.mjs. Regenerate with action/update-debs.sh; base image ${base}.`,
  snapshot: ts,
  debs: { x64: JSON.parse(amd64), arm64: JSON.parse(arm64) },
};
process.stdout.write(JSON.stringify(doc, null, 2) + "\n");
' "$amd64" "$arm64" "$ts" "$base" > "$here/debs.json"
echo "wrote $here/debs.json" >&2

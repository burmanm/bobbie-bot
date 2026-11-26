/**
 * `action/go-version.sh` (C-4): the prepare job's Go version from the head
 * commit's go.mod, held to a strict format. `gh` is a fake; no network.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "action", "go-version.sh");
const work = realpathSync(mkdtempSync(join(tmpdir(), "review-bot-go-version-")));
after(() => rmSync(work, { recursive: true, force: true }));

// gh api -H <accept> repos/<repo>/contents/<path>?ref=<sha>: prints $FAKE_FILES/<path>, records the call.
const FAKE_GH = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
url="\${@: -1}"
path="\${url#repos/*/contents/}"
path="\${path%%\\?*}"
[[ -f "$FAKE_FILES/$path" ]] || { echo "HTTP 404" >&2; exit 1; }
cat "$FAKE_FILES/$path"
`;

let n = 0;
function run(files: Record<string, string>, env: Record<string, string> = {}): Promise<{ code: number; version: string; calls: string; stderr: string }> {
  const dir = join(work, `t${n++}`);
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "gh"), FAKE_GH);
  chmodSync(join(bin, "gh"), 0o755);
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, "files", p)), { recursive: true });
    writeFileSync(join(dir, "files", p), text);
  }
  writeFileSync(join(dir, "output"), "");
  writeFileSync(join(dir, "calls"), "");
  return new Promise((done) => {
    execFile(
      "bash",
      [SCRIPT],
      {
        env: {
          PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          GITHUB_OUTPUT: join(dir, "output"),
          FAKE_FILES: join(dir, "files"),
          FAKE_LOG: join(dir, "calls"),
          GH_TOKEN: "ghs_token",
          RB_REPO: "k8ssandra/cass-operator",
          RB_HEAD_SHA: "a".repeat(40),
          ...env,
        },
      },
      (error, _stdout, stderr) => {
        const out = readFileSync(join(dir, "output"), "utf8");
        done({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          version: /^version=(.*)$/m.exec(out)?.[1] ?? "",
          calls: readFileSync(join(dir, "calls"), "utf8"),
          stderr: String(stderr),
        });
      },
    );
  });
}

test("the toolchain line wins, else the go line; read at the head SHA", async () => {
  const both = await run({ "go.mod": "module x\n\ngo 1.25.0\n\ntoolchain go1.26.11\n" });
  assert.equal(both.code, 0, both.stderr);
  assert.equal(both.version, "1.26.11");
  assert.match(both.calls, new RegExp(`repos/k8ssandra/cass-operator/contents/go\\.mod\\?ref=${"a".repeat(40)}`));
  assert.equal((await run({ "go.mod": "module x\n\ngo 1.26.11\n" })).version, "1.26.11");
  assert.equal((await run({ "go.mod": "module x\ngo 1.24 // comment\n" })).version, "1.24");
  assert.equal((await run({ "go.mod": "module x\ngo 1.27rc1\n" })).version, "1.27rc1");
});

test("the first go-modules directory; explicit versions pass through", async () => {
  const sub = await run({ "api/go.mod": "module y\ngo 1.23.4\n" }, { RB_GO_MODULES: "./api other" });
  assert.equal(sub.version, "1.23.4");
  assert.match(sub.calls, /contents\/api\/go\.mod\?ref=/);
  const given = await run({}, { RB_GO_VERSION: "1.22.x" });
  assert.equal(given.version, "1.22.x");
  assert.equal(given.calls, "", "nothing is fetched");
});

test("stable when there is no go.mod or no usable line; odd values never pass", async () => {
  assert.equal((await run({})).version, "stable");
  assert.equal((await run({ "go.mod": "module x\n" })).version, "stable");
  for (const line of ["go 1.26.11; curl evil", "go $(id)", "go 2.0", "go latest", "toolchain go1.26.11\ngo"]) {
    const r = await run({ "go.mod": `module x\n${line}\n` });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.version === "stable" || r.version === "1.26.11", `${line} -> ${r.version}`);
  }
});

test("bad inputs are refused", async () => {
  for (const env of [{ RB_REPO: "x" }, { RB_HEAD_SHA: "main" }, { RB_GO_MODULES: "../x" }, { RB_GO_MODULES: "/abs" }]) {
    const r = await run({ "go.mod": "go 1.26\n" }, env);
    assert.equal(r.code, 1, JSON.stringify(env));
    assert.equal(r.version, "");
  }
});

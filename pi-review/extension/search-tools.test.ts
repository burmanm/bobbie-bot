/**
 * grep and find replacements (C-3 "cannot hide anything", Q-14). They need
 * `rg`, which the review job provides; `fd` is not used.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { AllowedRoots } from "./paths.ts";
import { createSearchFindTool, createSearchGrepTool, findExecutable, RG_MISSING } from "./search-tools.ts";

const rg = findExecutable("rg");
const skipRg = rg === undefined ? "rg is not installed (the review job image must provide it)" : false;

let work: string;
let head: string;
let roots: AllowedRoots;

before(() => {
  work = mkdtempSync(join(tmpdir(), "review-bot-search-"));
  head = join(work, "head");
  mkdirSync(join(head, ".git"), { recursive: true });
  mkdirSync(join(head, "src", "deep"), { recursive: true });
  mkdirSync(join(head, "vendor"));
  mkdirSync(join(head, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(head, ".gitignore"), "vendor/\n*.gen.go\nnode_modules/\n");
  writeFileSync(join(head, ".ignore"), "src/deep/\n");
  writeFileSync(join(head, "src", "a.go"), "package src // NEEDLE one\n");
  writeFileSync(join(head, "src", "b.gen.go"), "package src // NEEDLE gen\n");
  writeFileSync(join(head, "src", "deep", "c.go"), "package deep // NEEDLE deep\n");
  writeFileSync(join(head, "vendor", "v.go"), "package v // NEEDLE vendor\n");
  writeFileSync(join(head, "node_modules", "pkg", "i.js"), "// NEEDLE node_modules\n");
  writeFileSync(join(head, ".hidden.go"), "package main // NEEDLE hidden\n");
  writeFileSync(join(work, "outside.go"), "package x // NEEDLE outside\n");
  symlinkSync(work, join(head, "up"));
  roots = new AllowedRoots([head]);
});

after(() => rmSync(work, { recursive: true, force: true }));

const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? "").join("");
const ctx = () => ({ cwd: roots.roots[0]! }) as never;

describe("grep", { skip: skipRg }, () => {
  const grep = () => createSearchGrepTool(roots.roots[0]!, roots);

  test("finds matches in ignored, hidden and vendored files", async () => {
    const out = text(await grep().execute("1", { pattern: "NEEDLE" }, undefined, undefined, ctx()));
    for (const f of ["src/a.go", "src/b.gen.go", "src/deep/c.go", "vendor/v.go", "node_modules/pkg/i.js", ".hidden.go"]) {
      assert.ok(out.includes(`${f}:1:`), `missing ${f} in:\n${out}`);
    }
    assert.ok(!out.includes("outside"), "followed a symlink out of the root");
  });

  test("glob, literal, ignoreCase, context, limit", async () => {
    const g = grep();
    const globbed = text(await g.execute("1", { pattern: "NEEDLE", glob: "*.gen.go" }, undefined, undefined, ctx()));
    assert.equal(globbed, "src/b.gen.go:1: package src // NEEDLE gen");
    const literal = text(await g.execute("1", { pattern: "NEEDLE (", literal: true }, undefined, undefined, ctx()));
    assert.equal(literal, "No matches found");
    const ci = text(await g.execute("1", { pattern: "needle deep", ignoreCase: true }, undefined, undefined, ctx()));
    assert.ok(ci.includes("src/deep/c.go:1:"));
    const limited = text(await g.execute("1", { pattern: "NEEDLE", limit: 2 }, undefined, undefined, ctx()));
    assert.match(limited, /2 matches limit reached/);
    assert.equal(limited.split("\n").filter((l) => l.includes(":1:")).length, 2);
  });

  test("searches a single file by path", async () => {
    const out = text(await grep().execute("1", { pattern: "NEEDLE", path: "src/a.go" }, undefined, undefined, ctx()));
    assert.equal(out, "a.go:1: package src // NEEDLE one");
  });

  test("refuses paths outside the roots", async () => {
    await assert.rejects(grep().execute("1", { pattern: "NEEDLE", path: "up" }, undefined, undefined, ctx()), /outside/);
    await assert.rejects(grep().execute("1", { pattern: "NEEDLE", path: ".." }, undefined, undefined, ctx()), /outside/);
  });

  test("an aborted search rejects", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(grep().execute("1", { pattern: "NEEDLE" }, controller.signal, undefined, ctx()), /aborted/);
  });
});

describe("find", { skip: skipRg }, () => {
  const find = () => createSearchFindTool(roots.roots[0]!, roots);
  const lines = async (args: { pattern: string; path?: string; limit?: number }) =>
    text(await find().execute("1", args, undefined, undefined, ctx())).split("\n");

  test("lists ignored, hidden and vendored files", async () => {
    const out = await lines({ pattern: "*.go" });
    for (const f of ["src/a.go", "src/b.gen.go", "src/deep/c.go", "vendor/v.go", ".hidden.go"]) {
      assert.ok(out.includes(f), `missing ${f} in ${out.join(",")}`);
    }
    assert.ok(!out.some((l) => l.includes("outside")));
    assert.ok((await lines({ pattern: "*.js" })).includes("node_modules/pkg/i.js"));
  });

  test("path patterns match at any depth, as with pi's fd", async () => {
    assert.deepEqual(await lines({ pattern: "deep/*.go" }), ["src/deep/c.go"]);
    assert.deepEqual(await lines({ pattern: "src/**/c.go" }), ["src/deep/c.go"]);
    assert.deepEqual(await lines({ pattern: "*.go", path: "src/deep" }), ["c.go"]);
  });

  test("limit", async () => {
    const out = await lines({ pattern: "*.go", limit: 2 });
    assert.ok(out.filter((l) => l.endsWith(".go")).length === 2, out.join(","));
  });

  test("refuses paths outside the roots", async () => {
    await assert.rejects(find().execute("1", { pattern: "*.go", path: "up" }, undefined, undefined, ctx()), /not found|outside/i);
  });
});

describe("rg availability", () => {
  test("a missing rg is a clear error, not a download", async () => {
    const grep = createSearchGrepTool(roots.roots[0]!, roots);
    const saved = process.env.PATH;
    process.env.PATH = "";
    try {
      await assert.rejects(grep.execute("1", { pattern: "x" }, undefined, undefined, ctx()), (e: Error) => e.message === RG_MISSING);
      const find = createSearchFindTool(roots.roots[0]!, roots);
      await assert.rejects(find.execute("1", { pattern: "*" }, undefined, undefined, ctx()), (e: Error) => e.message === RG_MISSING);
    } finally {
      process.env.PATH = saved;
    }
  });
});

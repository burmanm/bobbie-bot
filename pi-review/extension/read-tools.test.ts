/**
 * The read tools resolve in head, not in the session's cwd, and open the
 * file the guard judged (C-3, C-3a).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { checkToolCall } from "./guard.ts";
import { AllowedRoots } from "./paths.ts";
import { createConfinedLsTool, createConfinedReadTool, resolveInHead } from "./read-tools.ts";

let work: string;
let head: string;
let base: string;
let cwd: string;
let roots: AllowedRoots;

before(() => {
  work = mkdtempSync(join(tmpdir(), "review-bot-read-"));
  head = join(work, "runner", "head");
  base = join(work, "runner", "base");
  cwd = join(work, "cwd");
  for (const dir of [join(head, "sub"), base, join(cwd, "sub")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(head, "a.txt"), "HEAD-A");
  writeFileSync(join(head, "foo bar"), "HEAD-SPACE");
  writeFileSync(join(head, "sub", "b.txt"), "HEAD-B");
  writeFileSync(join(base, "a.txt"), "BASE-A");
  writeFileSync(join(work, "secret.txt"), "SECRET");
  // Decoys: same names in the session's cwd.
  writeFileSync(join(cwd, "a.txt"), "DECOY-A");
  writeFileSync(join(cwd, "cwd-only.txt"), "DECOY");
  writeFileSync(join(cwd, "sub", "b.txt"), "DECOY-B");
  symlinkSync(join(work, "secret.txt"), join(head, "out-link"));
  symlinkSync("a.txt", join(head, "in-link"));
  roots = new AllowedRoots([head, base]);
});

after(() => rmSync(work, { recursive: true, force: true }));

const ctx = () => ({ cwd }) as never;
const text = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? "").join("");
const guard = (toolName: string, input: Record<string, unknown>) =>
  checkToolCall({ type: "tool_call", toolCallId: "1", toolName, input } as never, { allowedTools: new Set(["read", "ls"]), roots });

describe("read", () => {
  const read = (path: string) => createConfinedReadTool(roots).execute("1", { path }, undefined, undefined, ctx());

  test("opens exactly the file the guard allowed", async () => {
    const allowed = ["a.txt", "./a.txt", "@a.txt", "sub/../a.txt", "sub/b.txt", "in-link", "foo\u00a0bar", "../base/a.txt", join(head, "a.txt"), join(base, "a.txt"), `file://${join(head, "a.txt")}`];
    for (const path of allowed) {
      assert.equal(guard("read", { path }), undefined, path);
      const checked = roots.check(path, roots.head);
      assert.ok(checked.ok, path);
      assert.equal(text(await read(path)), readFileSync(checked.path, "utf8"), path);
    }
    assert.equal(text(await read("a.txt")), "HEAD-A");
  });

  test("what the guard rejects, the tool rejects by itself", async () => {
    for (const path of ["../../secret.txt", "@../../secret.txt", "out-link", join(work, "secret.txt"), join(cwd, "a.txt"), "/etc/hosts"]) {
      assert.match(guard("read", { path }) ?? "", /outside/, path);
      await assert.rejects(read(path), /outside|not found/, path);
    }
  });

  test("a file that only the cwd has is not found", async () => {
    await assert.rejects(read("cwd-only.txt"), /not found/);
  });
});

describe("ls", () => {
  const ls = (path?: string) => createConfinedLsTool(roots).execute("1", path === undefined ? {} : { path }, undefined, undefined, ctx());

  test("omitted, empty and relative paths list head", async () => {
    for (const path of [undefined, "", "."]) {
      assert.equal(guard("ls", path === undefined ? {} : { path }), undefined);
      assert.deepEqual(text(await ls(path)).split("\n"), ["a.txt", "foo bar", "in-link", "out-link", "sub/"]);
    }
    assert.equal(text(await ls("sub")), "b.txt");
  });

  test("the cwd cannot be listed", async () => {
    await assert.rejects(ls(cwd), /not found/);
  });
});

test("resolveInHead changes only the cwd the tool sees, and reads the rest of the context when used", async () => {
  let model = "first";
  const original = { cwd, get model() { return model; } };
  let seen: { cwd: string; model: unknown } | undefined;
  const probe = resolveInHead(
    {
      ...createConfinedLsTool(roots),
      execute: async (_id, _params, _signal, _update, context) => {
        model = "second";
        seen = { cwd: context.cwd, model: context.model };
        return { content: [], details: undefined };
      },
    },
    roots.head,
  );
  await probe.execute("1", {}, undefined, undefined, original as never);
  assert.deepEqual(seen, { cwd: roots.head, model: "second" });
  assert.equal(original.cwd, cwd);
});

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { checkToolCall, createToolCallGuard } from "./guard.ts";
import { AllowedRoots } from "./paths.ts";

let work: string;
let head: string;
let base: string;
let roots: AllowedRoots;

before(() => {
  // tmpdir() is a symlink on macOS (/var -> /private/var): roots given
  // through a symlink must still work.
  work = mkdtempSync(join(tmpdir(), "review-bot-paths-"));
  head = join(work, "head");
  base = join(work, "base");
  mkdirSync(join(head, "sub"), { recursive: true });
  mkdirSync(base);
  writeFileSync(join(head, "a.txt"), "a");
  writeFileSync(join(head, "foo bar"), "nbsp");
  writeFileSync(join(work, "secret.txt"), "secret");
  writeFileSync(join(base, "b.txt"), "b");
  symlinkSync(join(work, "secret.txt"), join(head, "out-link"));
  symlinkSync(join(head, "a.txt"), join(head, "in-link"));
  symlinkSync(work, join(head, "sub", "up"));
  symlinkSync(join(base, "b.txt"), join(head, "to-base"));
  roots = new AllowedRoots([head, base]);
});

after(() => rmSync(work, { recursive: true, force: true }));

describe("AllowedRoots.check", () => {
  const ok = (raw: string) => {
    const r = roots.check(raw, roots.roots[0]!);
    assert.equal(r.ok, true, `${raw}: ${JSON.stringify(r)}`);
  };
  const blocked = (raw: unknown) => {
    const r = roots.check(raw, roots.roots[0]!);
    assert.equal(r.ok, false, `${String(raw)} was allowed`);
  };

  test("roots are canonical", () => {
    assert.deepEqual(roots.roots, [realpathSync(head), realpathSync(base)]);
  });

  test("allows paths inside any root", () => {
    ok("a.txt");
    ok(".");
    ok("sub");
    ok("./sub/../a.txt");
    ok("missing/not-yet.txt"); // does not exist, but cannot escape
    ok(join(head, "a.txt")); // through the non-canonical tmpdir
    ok(join(base, "b.txt"));
    ok("in-link");
    ok("to-base"); // a symlink from one root into another
    ok("@a.txt");
    ok(`file://${join(head, "a.txt")}`);
  });

  test("blocks paths that leave the roots", () => {
    blocked("..");
    blocked("../secret.txt");
    blocked(join(work, "secret.txt"));
    blocked("/");
    blocked("/etc/passwd");
    blocked("~");
    blocked("~/.ssh/id_rsa");
    blocked("@../secret.txt");
    blocked("@~/x");
    blocked("out-link");
    blocked("sub/up/secret.txt");
    blocked("sub/up/missing");
    blocked(`file://${join(work, "secret.txt")}`);
    blocked(join(base, "..", "secret.txt"));
    blocked(42);
  });

  test("normalizes unicode spaces as pi does", () => {
    // pi turns U+00A0 into a plain space before resolving; the check must
    // judge the same path pi will open.
    const r = roots.check(".. /x", roots.roots[0]!);
    assert.equal(r.ok, true); // ".. /x" is a directory named ".. " inside head
    blocked(" ../secret.txt".trimStart());
  });
});

describe("AllowedRoots.resolveForAccess", () => {
  test("resolves an existing path inside a root", () => {
    assert.equal(roots.resolveForAccess(join(head, "in-link")), realpathSync(join(head, "a.txt")));
  });
  test("rejects escaping symlinks and missing paths", () => {
    assert.throws(() => roots.resolveForAccess(join(head, "out-link")), /outside the allowed read roots/);
    assert.throws(() => roots.resolveForAccess(join(head, "nope")), /Path not found/);
  });
});

describe("AllowedRoots construction", () => {
  test("rejects missing or relative roots", () => {
    assert.throws(() => new AllowedRoots([]), /at least one/);
    assert.throws(() => new AllowedRoots(["relative"]), /absolute/);
    assert.throws(() => new AllowedRoots([join(work, "nope")]), /does not exist/);
  });
});

describe("checkToolCall", () => {
  const options = () => ({ allowedTools: new Set(["read", "grep", "report_x"]), roots });
  const call = (toolName: string, input: Record<string, unknown>, parentToolCallId?: string) =>
    ({ type: "tool_call", toolCallId: "1", toolName, input, ...(parentToolCallId ? { parentToolCallId } : {}) }) as never;

  test("allowlist", () => {
    assert.match(checkToolCall(call("bash", { command: "id" }), options()) ?? "", /not on this step's allowlist/);
    assert.match(checkToolCall(call("ls", {}), options()) ?? "", /not on this step's allowlist/);
    assert.equal(checkToolCall(call("report_x", { path: "/etc/passwd" }), options()), undefined);
  });
  test("path arguments", () => {
    assert.equal(checkToolCall(call("grep", { pattern: "x" }), options()), undefined);
    assert.match(checkToolCall(call("read", {}), options()) ?? "", /path must be a string/);
    assert.match(checkToolCall(call("grep", { pattern: "x", path: ".." }), options()) ?? "", /outside/);
  });
  test("relative paths are judged against head, whatever the session's cwd is (C-3a)", () => {
    // Judged against the neutral cwd this is rejected: the trap of R-1a step 1.
    assert.equal(roots.check("a.txt", join(work, "cwd")).ok, false);
    assert.equal(roots.head, realpathSync(head));
    const guard = createToolCallGuard(options());
    assert.equal(guard(call("read", { path: "a.txt" })), undefined);
    assert.equal(guard(call("read", { path: "../secret.txt" }))?.block, true);
  });
  test("nested calls are refused", () => {
    assert.match(checkToolCall(call("read", { path: "a.txt" }, "p"), options()) ?? "", /from another tool/);
  });
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandArgsError, quoteCommandArgs, splitCommandArgs } from "./command-args.ts";

test("arguments round-trip through quoting", () => {
  const cases = [
    [],
    ["--dry-run", "--fixture", "/a/b"],
    ["--waiting", '{"ci":"passed","required":["a b"]}'],
    ["it's", "", " lead", "tab\there", "new\nline", "back\\slash", "$HOME", "`x`", "a'b'c", '"q"'],
  ];
  for (const args of cases) assert.deepEqual(splitCommandArgs(quoteCommandArgs(args)), args, JSON.stringify(args));
});

test("typed text: double quotes, backslashes, extra whitespace", () => {
  assert.deepEqual(splitCommandArgs('  --out "my file.json"   --name a\\ b '), ["--out", "my file.json", "--name", "a b"]);
  assert.deepEqual(splitCommandArgs('"a \\" \\\\ \\n"'), ['a " \\ \\n']);
  assert.deepEqual(splitCommandArgs(""), []);
});

test("an unclosed quote is an error, not a guess", () => {
  for (const bad of ["'abc", '"abc', "abc\\"]) assert.throws(() => splitCommandArgs(bad), CommandArgsError, bad);
});

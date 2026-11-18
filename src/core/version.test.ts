import { test } from "node:test";
import assert from "node:assert/strict";
import { BOT_VERSION } from "./version.ts";

test("bot version is set", () => {
  assert.match(BOT_VERSION, /^\d+\.\d+\.\d+$/);
});

/**
 * scrubSecrets (C-3, C-7, A-6 saved scripts). Every token-shaped value is
 * built at run time, so none is committed (AGENTS.md).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { scrubSecrets } from "./query-tools.ts";

const R = "[redacted]";
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const classic = (kind: string, body = "A1b2".repeat(9)) => ["gh", kind, "_", body].join("");
const fineGrained = () => ["github", "pat", "Z9".repeat(11), "q".repeat(59)].join("_");

/** An installation token of the form ghs_<app id>_<JWT>, with a made-up signature. */
function installation(appId = "12345", header: object = { alg: "FAKE", typ: "JWT" }, signature = "not-a_signature-".repeat(20)) {
  const jwt = [b64(header), b64({ iss: "synthetic", note: "not a credential" }), signature].join(".");
  return ["ghs", appId, jwt].join("_");
}

describe("installation tokens ghs_<digits>_<JWT>", () => {
  test("the whole token is redacted, underscores, dots and dashes included", () => {
    const token = installation();
    assert.match(token, /\..*_.*-/, "the fixture has the characters the old pattern missed");
    assert.equal(scrubSecrets(token), R);
  });

  test("app ids of any length, and other header key orders", () => {
    for (const appId of ["1", "987654", "1".repeat(20), "2".repeat(40)]) assert.equal(scrubSecrets(installation(appId)), R);
    for (const header of [{ typ: "JWT", alg: "FAKE" }, { kid: "synthetic", alg: "FAKE" }, { x5t: "x", alg: "FAKE" }]) {
      assert.equal(scrubSecrets(installation("7", header)), R);
    }
  });

  test("a signature that starts or ends with a dash or underscore", () => {
    for (const signature of ["-abc-", "_abc_", "a--__--b"]) assert.equal(scrubSecrets(installation("7", undefined, signature)), R);
  });

  test("the text around a token is kept", () => {
    const t = installation();
    for (const [before, after] of [
      ["", "."],
      ["token=", "&x=1"],
      ['const t = "', '";'],
      ["Authorization: Bearer ", "\r\nnext"],
      ["https://x-access-token:", "@github.com/o/r"],
      ["(", "), then"],
      ["`", "`"],
    ] as const) {
      assert.equal(scrubSecrets(`${before}${t}${after}`), `${before}${R}${after}`);
    }
  });

  test("found where there is no word boundary: escapes and prefixes", () => {
    const t = installation();
    assert.equal(scrubSecrets(JSON.stringify({ out: `line\n${t}` })), JSON.stringify({ out: `line\n${R}` }));
    assert.equal(scrubSecrets(`Bearer%20${t}`), `Bearer%20${R}`);
    assert.equal(scrubSecrets(`TOKEN_${t}`), `TOKEN_${R}`);
  });

  test("a token cut short is redacted", () => {
    const t = installation();
    const jwtStart = t.indexOf("_", "ghs_".length) + 1;
    for (let n = jwtStart + "eyJ".length + 10; n < t.length; n++) {
      // A cut straight after a dot leaves the dot.
      assert.equal(scrubSecrets(t.slice(0, n)), t[n - 1] === "." ? `${R}.` : R, `cut at ${n}`);
    }
  });

  test("several in one text", () => {
    assert.equal(scrubSecrets(`${installation("1")} ${installation("2")}\n${classic("p")}`), `${R} ${R}\n${R}`);
  });
});

describe("the existing forms", () => {
  test("opaque and fine-grained tokens", () => {
    for (const t of [..."opsur"].map((kind) => classic(kind)).concat(fineGrained(), classic("s", "7".repeat(20)))) {
      assert.equal(scrubSecrets(`a ${t}.`), `a ${R}.`);
    }
  });

  test("redacting twice changes nothing more", () => {
    const once = scrubSecrets(`${installation()} ${classic("o")} ${fineGrained()}`);
    assert.equal(scrubSecrets(once), once);
  });
});

describe("ordinary text is left alone", () => {
  const long = "abcdefghij".repeat(4);
  for (const text of [
    "ghs_token",
    "ghs_installation_token_for_the_pilot_repository_owner",
    "ghs_service.account.name.with.many.parts.and.more",
    "ghs_2_replicas_of_the_statefulset_are_ready",
    "ghs_123_config.settings.maximum_retries_before_failure",
    "ghs_12345_eyJ",
    "ghs_12345_eyJshort.x.y",
    "ghs_<digits>_<JWT>",
    `highs_${long}`,
    `weighs_${long}`,
    `ghs_${long}_suffix`,
    `ghp_${long}_suffix`,
    "github_pat_",
    "ghx_" + long,
    "eyJ" + long,
    "const re = /ghs_\\d+_eyJ[A-Za-z0-9_-]+/;",
  ]) {
    test(text, () => assert.equal(scrubSecrets(text), text));
  }
});

describe("large adversarial input", () => {
  const SIZE = 2_000_000;
  const fill = (unit: string) => unit.repeat(Math.ceil(SIZE / unit.length));
  const eyJ = "ey" + "J";
  const inputs: Record<string, () => string> = {
    "repeated prefixes": () => fill("ghs_"),
    "repeated prefixes with digits": () => fill("ghs_1_"),
    "one long digit run": () => `ghs_${fill("1")}x`,
    "digits without a JWT": () => `ghs_${fill("1")}_x`,
    "headers just too short": () => fill(`ghs_1_${eyJ}aaaaaaaaa.`),
    "one long header": () => `ghs_1_${eyJ}${fill("a")}`,
    "many dots after a header": () => `ghs_1_${eyJ}${"a".repeat(10)}${fill(".")}`,
    "many segments": () => `ghs_1_${eyJ}${"a".repeat(10)}${fill(".a")}`,
    "opaque body with no boundary": () => `ghp_${fill("a")}_`,
    "opaque starts with no boundary": () => fill(`-ghp_${"a".repeat(20)}_`),
    "fine-grained prefixes": () => fill("github_pat_"),
    "fine-grained body": () => `github_pat_${fill("a_")}`,
  };
  for (const [name, build] of Object.entries(inputs)) {
    test(name, () => {
      const text = build();
      const started = performance.now();
      scrubSecrets(text);
      // Linear takes milliseconds; quadratic at this size takes hours.
      assert.ok(performance.now() - started < 5_000);
    });
  }
});

# Security: threat model and hostile-input testing

This records which attacks on review-bot were considered, which were tried,
what happened, and what is still open. Failures are listed next to successes.

It is a self-assessment by the project (design decisions by the owner; probes
written and run with an AI coding agent). It is not an independent audit or a
penetration test, and it does not show that the bot is free of vulnerabilities.

| | |
|---|---|
| Last updated | 2026-11-22 |
| Code assessed | `87d71b2` |
| Environment of the probes | macOS (Darwin 24.6.0), Node 24.15.0, git 2.50.1, pi 1.5.2. Fake models and fake secrets |
| Test suite at that commit | 343 tests, 343 passed, 0 skipped |
| Not exercised | Linux, the Docker image, a live GitHub workflow, third-party pi modules. A real model saw a planted `AGENTS.md` once, in the R-0 spike; no other attack was tried on a real model |

The rules are in the plan ([C-3, C-3a, C-4](plan/06-ci-and-security.md#c-3--trust-model)).
This file is the evidence for them.

## How to read the evidence

| Mark | Meaning | Strength |
|---|---|---|
| **Test** | An automated test in this repository | Repeats on every `npm test` |
| **Probe** | A one-off hostile experiment, described under [Probe procedures](#probe-procedures) | True for the commit and environment above |
| **Spike** | Observed in the [R-0 spike](plan/spike-r0-findings.md), 2026-11-15 | Historical |
| **Read** | Concluded from source, not exercised | Weakest |

| Status | Meaning |
|---|---|
| Blocked | The attack was tried and failed |
| Planned | It works, or would work once R-1a features land. The fix is in the plan and not merged |
| Open | It works, or is believed to, and no fix is decided |
| Accepted | A known risk the owner decided to carry |

## Threat model

**Attacker:** anyone who can influence what the bot reads: a pull request's
files, diff, title, description, commit messages and comments, including from
a fork. Prompt injection of the model is assumed to succeed sometimes.

**Protected:** the GitHub token, the model provider key, the runner, the
integrity of the review and its check, and private source code.

**Trust line ([D-19](plan/README.md#key-decisions), decided 2026-11-22):**
nothing from a PR is executed or becomes configuration without a merge. What
maintainers merged is trusted.

**Out of scope:** a maintainer merging a harmful module or setting (including
after social engineering), people with write access (who can reach repository
secrets from a branch workflow), and compromise of GitHub, the model provider
or a pinned dependency.

## Summary of what is not closed

| ID | Issue | Affects today | Status |
|---|---|---|---|
| [H-50](#open-findings) | A bot that echoes PR text can forge review-bot's state, so a review is skipped | Yes | Open |
| [H-51](#open-findings) | Model text is posted as live Markdown: images, links, mentions, commands | Yes | Open |
| [H-52](#open-findings) | An injected re-check can resolve the bot's own blocking thread | Yes (from code) | Open |
| [H-53](#open-findings) | ACP agents' own tools are outside the bot's confinement | When ACP is configured (not in the action) | Open |
| [H-40](#planned-fixes) | Working directory is the PR's tree, so modules take config from it | Once modules load | Planned, R-1a step 1 |
| [H-41](#planned-fixes) | An embedded bare git repository runs commands | Once something runs git there | Planned, R-1a step 1 |
| [H-42](#planned-fixes) | Base-branch YAML can raise limits and change models | Yes | Planned, R-1a step 2 |
| [H-43](#planned-fixes) | The secret scrubber misses dotted `ghs_` tokens | Yes | Planned, R-1a step 5 |
| [H-60](#accepted-risks) | Modules share the process with the token and key | Once modules load | Accepted |

## Hostile attempts

### Loading code or instructions from a PR

| ID | Attempt | Result | Evidence |
|---|---|---|---|
| H-01 | PR ships `.pi/extensions/` code | Blocked: did not run. The control (pi SDK defaults) does run it | Test: `src/agent/isolation.test.ts`; Spike §1 |
| H-02 | PR's `.pi/settings.json` enables `bash`, `write` and a planted tool | Blocked: not offered, and calls to them failed | Test: same |
| H-03 | PR ships `SYSTEM.md`, `APPEND_SYSTEM.md`, skills, prompt templates | Blocked: no canary reached the model | Test: same |
| H-04 | `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md` in the PR and in parent directories | Blocked: no canary reached the model. pi's project trust alone does not stop these | Test: same; Spike §9 |
| H-05 | Hostile user-level pi directory and home directory on the runner | Blocked | Test: same |
| H-06 | With the pi CLI, an extension's `project_trust` handler trusts the PR directory | Works with defaults (the PR's extension ran). Blocked by `--no-approve`, which R-1a requires | Probe P-C |
| H-07 | PR `.npmrc` sets `prefix` so pi resolves a configured, missing package to PR code | Blocked: npm ignored it and the planted package did not load | Probe P-A |

### Reading outside the snapshot

| ID | Attempt | Result | Evidence |
|---|---|---|---|
| H-10 | Absolute paths, `..`, `~`, `@` prefix, `file://` URLs in the read tools | Blocked | Test: `src/agent/isolation.test.ts`, `pi-review/extension/paths.test.ts` |
| H-11 | Symlinks out of head or base, to files and directories | Blocked for read, list and search | Test: same |
| H-12 | `grep`, `find` or `ls` pointed at a parent, outside or root directory | Blocked | Test: same, `pi-review/extension/search-tools.test.ts` |
| H-13 | `.gitignore`, `.ignore`, `.rgignore` or binary content used to hide code from the reviewer | Blocked: still found. The control shows plain ripgrep hiding the git-ignored file | Test: same |
| H-14 | History and issue search widened to other repositories through query qualifiers | Blocked | Test: `src/pipeline/history-tools.test.ts` |

### Making the model act

| ID | Attempt | Result | Evidence |
|---|---|---|---|
| H-20 | Model calls `bash`, `write` or a planted tool | Blocked: nothing ran, no file was written | Test: `src/agent/isolation.test.ts` |
| H-21 | A tool calls another tool to get around the allowlist | Blocked today: every nested call is refused | Test: `pi-review/extension/paths.test.ts` |
| H-22 | An ACP agent asks the client to read or write files or execute | Blocked at the client. GitHub tokens are withheld from its environment | Test: `src/agent/acp/acp-step.test.ts` |
| H-23 | Codemode script reads outside files, by absolute path and `..` | Blocked, with nested calls allowed as R-1a plans | Probe P-A |
| H-24 | Codemode script reaches `process`, `require`, `fetch` or environment-like globals | Blocked: none exist in the sandbox | Probe P-A |
| H-25 | Codemode script reads `/proc/self/environ` | Blocked by the path guard. macOS has no `/proc`, so not exercised against a real one | Probe P-A |
| H-26 | Codemode script dumps the model catalog to get a key from `models.json` | Blocked: neither the key nor the auth header canary was returned | Probe P-A |
| H-27 | Codemode script calls a registered tool the role was not given | Blocked: the tool does not exist for the script | Probe P-B |
| H-28 | Endless codemode script | Stopped when given a deadline. Scripts have none by default; R-1a relies on step timeouts and will test that | Probe P-B |
| H-29 | A module replaces `read` to escape confinement | The replacement does load. The path guard still blocked the outside path; without the guard the replacement ran | Probe P-B |

### Attacking the CI jobs

| ID | Attempt | Result | Evidence |
|---|---|---|---|
| H-30 | Snapshot archive with `..`, absolute paths, unexpected top-level paths | Blocked: refused | Test: `src/ci/tar.test.ts` |
| H-31 | Archive writes through symlinks, or uses hard links, devices, FIFOs, duplicates | Blocked: refused. Extracted files are read-only and not executable | Test: same |
| H-32 | Oversized archive or too many members | Blocked: capped | Test: same |
| H-33 | `go.mod` steers the Go toolchain, proxy, VCS or reaches the token | Hardened: environment pinned, runs on a copy, token absent (asserted with a fake `go`) | Test: `src/ci/prepare.test.ts` |
| H-34 | Shell injection through workflow expressions | Blocked: no expression is interpolated into a script | Test: `src/ci/workflow.test.ts` |
| H-35 | PR code checked out, or secrets present, in the wrong job | Blocked by construction: no checkout, least permissions per job, model key only in review, actions pinned by SHA | Test: same |
| H-36 | Extraction reaches the network or secrets; review container gets extra secrets | Blocked: extraction has no network or keys; review gets named variables only, a read-only snapshot, dropped capabilities (asserted on the Docker arguments) | Test: `src/ci/run-sh.test.ts` |
| H-37 | Outsider triggers a paid review, applies the label without write access, or pushes after approval | Blocked | Test: `src/ci/gate.test.ts` |
| H-38 | GitHub token sent to another host or echoed in an error | Blocked | Test: `src/platform/github.test.ts`, `src/ci/gate.test.ts` |

### Forging the bot's output or state

| ID | Attempt | Result | Evidence |
|---|---|---|---|
| H-70 | A user posts a comment containing the bot's hidden marker | Blocked: markers count only from Bot-type authors (but see H-50) | Probe P-D |
| H-71 | Model or PR text carries a marker into the bot's own comment | Blocked: neutralized | Test: `src/core/fingerprint.test.ts`, `src/pipeline/run.test.ts`; Probe P-D |
| H-72 | PR text closes the untrusted-data delimiter in the prompt | Blocked: neutralized. This is hygiene, not a defence against injection | Test: `src/pipeline/run.test.ts`; Probe P-D |
| H-73 | Invented evidence | Blocked: quotes are checked against the files | Test: `src/core/grounding.test.ts` |
| H-74 | The bot is made to approve or request changes | Blocked: any review event other than COMMENT is refused | Test: `src/platform/github.test.ts` |

## Planned fixes

**H-40: working directory.** Sessions run with cwd set to the PR's head. A
harmless test module that reads `<cwd>/.formatter.json` received the PR's
command. With an empty cwd it received nothing (Probe P-A). Not exploitable
in today's action, which loads no modules. Fix: R-1a step 1.

**H-41: embedded bare repository.** A tree with `tool/HEAD`, `tool/config`
(`core.fsmonitor` set to a command), `tool/objects/` and `tool/refs/`
survived `git archive` and the bot's extractor. `git status` in that
directory ran the command. With `safe.bareRepository=explicit` it did not
(Probes P-A, P-D). Not exploitable in today's action, whose image has no git.
Fix: R-1a step 1.

**H-42: base-branch YAML.** `.review/review-bot.yaml` raised a cost cap from
2 to 900 and replaced the model (Probe P-D). It needs write access to some
base branch, but not a merge to the default one. Fix: R-1a step 2,
narrowing only.

**H-43: secret scrubber.** `scrubSecrets` redacts a classic `ghs_` token and
misses a synthetic `ghs_<digits>_<a>.<b>.<c>` one (Probe P-D). It is a second
layer: no default tool returns the token. Fix: R-1a step 5.

## Open findings

**H-50: state forged through another bot.** Markers are trusted from *any*
Bot-type author, because the Actions login is shared. If another bot or
workflow on the repository repeats PR-controlled text, the PR can place a
marker in that bot's comment. In Probe P-D this made the current head count
as already reviewed (skip reason `already-reviewed`) and planted an "own"
earlier finding. From the code, a forged earlier SHA would also narrow the
review to an incremental diff, leaving earlier changes unreviewed. Possible
direction: also check the author identity, or authenticate markers.

**H-51: live Markdown in posted text.** Only markers are neutralized. In
Probe P-D an image with a URL query, a link, an `@org/team` mention and a
line starting `/approve` all reached the comment body unchanged. An injected
model could therefore put private code in an image URL that is fetched when
the comment is rendered, send phishing links under the bot's name, notify
teams, or address other bots. Delivery through GitHub's renderer was not
tested. This contradicts C-3's "the model cannot exfiltrate" for anything
the model can read. Possible direction: escape or strip these before
publishing.

**H-52: injected "verified fixed".** A re-check verdict of `fixed` makes the
bot resolve its own thread (Read: `src/pipeline/run.ts`, Q-9). Open threads
are what block a merge (P-8), so a successfully injected verifier can lift
that block. C-3's "can only emit findings" understates this. The bot cannot
approve, and human review still applies.

**H-53: ACP agents.** The client refuses file and execute requests (H-22),
but an agent's own tools run in the agent's process and are not confined by
the bot, and the provider key stays in its environment (Read:
`src/agent/acp/acp-step.ts`). The action does not configure ACP agents.

## Accepted risks

**H-60: modules are trusted (D-19, owner, 2026-11-22).** A configured module
runs in the process that holds the GitHub token and model key. In Probe P-B a
test module's tool returned a fake `GH_TOKEN` to a codemode script. A module
that gives the model a shell, network access or an unconfined reader gives
the same to a PR author through prompt injection. A process split was
considered and declined: enabling such a module takes a maintainer's merge.
Mitigations planned in R-1a: read-only defaults, tools enabled per role, the
extra tools listed in the review summary.

**H-61: injection can degrade a review.** An injected reviewer can miss bugs,
report nothing or post wrong findings. Bounded by grounding, limits, no
approval, and human review.

## Probe procedures

All probes used temporary directories, fake secrets and pi's scripted model
or a fake provider. Payloads only wrote a marker file or printed a string.
All four were run or re-run on 2026-11-22 against `87d71b2`.

**P-A: hostile snapshot and codemode.**
1. Create a head directory with `.formatter.json` (a `command` field), an
   `.npmrc` setting `prefix` into the tree with a planted package there, and
   an embedded bare repository.
2. Create an agent directory with a module that reads `<cwd>/.formatter.json`
   and a `models.json` whose key and header come from a canary variable.
3. Create an SDK session with codemode and the bot's extension, with the
   guard changed only to permit codemode and nested calls. The scripted model
   sends one script that tries each of H-23 to H-26.
4. Run with cwd at head and at an empty directory. Search results for the
   canaries. Run `npm root -g`, pi with the missing package, and `git status`
   in each directory.

**P-B: modules and tool replacement.**
1. Load a local package that registers a codemode-only tool returning
   `process.env.GH_TOKEN` (a canary) and, optionally, a tool named `read`.
2. Call them directly and from codemode, with and without the tool in the
   session's list, with and without the guard. Run `while(true){}` with a
   300 ms script deadline.

**P-C: pi as the entry point.**
1. Run the pi CLI in a directory with `.pi/extensions/h.js`, and an `-e`
   extension whose `project_trust` handler answers yes.
2. Repeat with `--no-approve`. The failure-reporting results of the same
   probe are in [r1a-proposal.md](plan/r1a-proposal.md).

**P-D: state, output, configuration, scrubber, archive.**
1. Pass `derivePriorState` comments holding valid summary and finding markers
   from a User and from a Bot author, then `skipBeforeDiff` the result.
2. Pass `findingCommentBody` a body with an image, link, mention, command
   line and marker. Pass delimiter look-alikes to `neutralizeDelimiters`.
3. Pass `resolveConfig` a cap of 2 and a YAML asking for 900 and another
   model. Pass `scrubSecrets` both synthetic token shapes.
4. Put the bare repository in a git tree, `git archive` it, extract it with
   `unpackTarGz`, and run `git status` inside with and without
   `safe.bareRepository=explicit`.

## Reproducing the automated evidence

```bash
npm ci --ignore-scripts
npm test
```

The search-tool tests skip when `rg` is not installed; check that the run
reports 0 skipped.

## Keeping this record

- Add a row for every new attempt, including failed attacks and findings
  that are later fixed. IDs are never reused.
- When a fix merges, keep the finding, change its status and name the commit
  and the regression test that replaces the probe.
- Review this file on every pi upgrade and whenever C-3, C-3a or C-4 changes.
- Git history is the dated record: commit each change to this file.

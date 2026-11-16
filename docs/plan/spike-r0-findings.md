# R-0 spike findings: pi integration

Answers the ten questions in
[F-6](01-foundation-pi.md#f-6--to-verify-in-the-phase-0-spike). Run on
2026-11-15 against `@earendil-works/pi-coding-agent` **1.5.2** (published
2026-11-10), Node 24.15.0, macOS. All ten questions are answered; every
model-dependent one was run live (`OPENROUTER_API_KEY` was set). Total model
spend was under one US cent.

**Recommendation in one line:** use the SDK, pin pi to exactly `1.5.2`, and
adopt the `AgentStep` signature at the [end of this file](#recommendation).

## How to read the evidence

- **Observed** means a check in the throwaway scripts under `spike/` passed.
  Commands: `cd spike && npm ci --ignore-scripts && node spike.ts` and
  `node subprocess-probe.ts` (see `spike/README.md`). The outputs quoted here
  are saved in `spike/output/*.log`. `node spike.ts offline` (41 checks) needs
  no key and no network; `node spike.ts live` (13 checks) needs the key.
- **Source** means read in the installed package. pi ships compiled files
  only, so references are to `dist/…js:line` inside
  `spike/node_modules/@earendil-works/pi-coding-agent/` (or `pi-ai/`,
  `pi-agent-core/`). The upstream file is the same path under
  `packages/<pkg>/src/` with a `.ts` extension.
- **Doc** means pi's own documentation, shipped in the package under `docs/`.
- The test snapshot (`spike/fixtures/snapshot/`) is a tiny synthetic Go
  repository, not a cass-operator PR as R-0 originally said. It contains
  planted hostile files: `AGENTS.md`, `.pi/extensions/planted.ts`,
  `.pi/SYSTEM.md`, `.pi/settings.json` and a `.gitignore`.
- Not tested: Linux, Node 22, more than one read root, `find` (needs the
  `fd` binary, which is not installed on the test machine).

## Summary

| # | Question | Short answer | Contradicts the plan? |
|---|---|---|---|
| 1 | Load our extension, nothing from the working directory | Yes, but only with explicit options. **SDK defaults trust the project** | **Yes** |
| 2 | How the API key is passed | Environment variable, or `ModelRuntime.setRuntimeApiKey()` in memory, or `auth.json` | No |
| 3 | Token and cost fields | `message_end` → `message.usage`; totals from `session.getSessionStats()` | No |
| 4 | CLI exit codes | `--mode json` exits **0** on a model error; `-p` exits 1; SIGTERM → 143 | Adds detail |
| 5 | Confine built-in read tools | **Not confined by pi.** Our `tool_call` guard must check paths | **Yes** |
| 6 | Tool schema violated | Error result goes back to the model, which is called again | No |
| 7 | Several sessions in one process | Safe in the test (6 in parallel) | No |
| 8 | `LICENSE` in `packages/durable` | No file; `package.json` says MIT; repository root `LICENSE` is MIT | No |
| 9 | `AGENTS.md` discovery | Walks from cwd to the filesystem root; **not covered by project trust** | **Yes** |
| 10 | OpenRouter cost, cached tokens, routing | All three work | No |

---

## 1. Loading our extension and nothing from the working directory

**Answer.** Possible, and proven. But the safe behaviour is not the default:
a plain `createAgentSession({ cwd: snapshot })` **executes the snapshot's
`.pi/extensions/*.ts`**, applies its `.pi/settings.json`, uses its
`.pi/SYSTEM.md` and puts its `AGENTS.md` in the system prompt.

**Why.** Project trust (the prompt, `defaultProjectTrust`, `--no-approve`) is
resolved by the CLI. In the SDK, `SettingsManager` starts with
`projectTrusted = true` unless told otherwise
(Source: `dist/core/settings-manager.js:238`), and
`DefaultResourceLoader.reload()` only runs the trust decision if the caller
passes `resolveProjectTrust` (`dist/core/resource-loader.js:376-380`).

**The session shape that isolates** (`createIsolatedSession` in
`spike/spike.ts`):

| Option | Keeps out |
|---|---|
| `SettingsManager.inMemory(settings, { projectTrusted: false })` | `<snapshot>/.pi/settings.json`, `.pi/extensions`, `.pi/skills`, `.pi/prompts`, `.pi/themes`, `.pi/SYSTEM.md`, `.pi/APPEND_SYSTEM.md`, project `.agents/skills`; also `~/.pi/agent/settings.json` |
| `agentDir` = a private empty directory (and `PI_CODING_AGENT_DIR`) | `~/.pi/agent/` extensions, `auth.json`, `models.json`, global `AGENTS.md` |
| `new DefaultResourceLoader({ noExtensions: true, additionalExtensionPaths: [ourExtension], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt, appendSystemPrompt: [] })` | Everything discovered; explicit paths still load. `noSkills` also covers `~/.agents/skills`, which ignores `agentDir` |
| `SessionManager.inMemory(cwd)` | Session files |
| `tools: [allowlist]` | Every tool not named |

**Observed** (`spike/output/offline-run.log`, sections 1 and 2):

- Control with defaults: extensions loaded = `…/head/.pi/extensions/planted.ts`;
  active tools = `bash, write, planted_tool`; both canary strings in the
  system prompt.
- Isolated: extensions loaded = `spike/extension/review-extension.ts` only;
  planted file not executed; registered tools = `read, grep, find, ls,
  report_finding`; system prompt = our text plus a `<cwd>` section.
- Live: the first request body sent to OpenRouter contained no canary text,
  and the model reported findings despite the planted `AGENTS.md` telling it
  not to (`live-run.log`, section 5).
- Separate process: `pi --mode json` with no trust flag and with
  `--no-approve` did not execute the planted extension; with `--approve` it
  did (`subprocess-probe.log`, J–L).

**Notes.**

- Isolation stops *loading*. The planted files are still ordinary files the
  model can `read` (`ls` lists `.pi/` and `AGENTS.md`). Their text then
  reaches the model as untrusted data, like any other file in the PR.
- A custom `systemPrompt` replaces pi's coding-assistant preamble, its tool
  list and its rules. pi still appends a `<cwd>` section with the absolute
  snapshot path.
- An in-process alternative to loading by path: pass the extension as a
  function in `extensionFactories`. It skips the jiti loader and can take
  configuration by closure. The spike uses this for a request-capturing hook.
- Doc: `docs/security.md` ("Understand project trust"), `docs/sdk.md`
  ("Configuring a session"), `examples/sdk/12-full-control.ts`.

**Contradicts the plan.** C-3 says "pi project trust is off". With the SDK it
is on until we turn it off. The rule should name the mechanism:
`projectTrusted: false` (or in-memory settings), `noContextFiles`, and a
private `agentDir`. A test that plants the hostile files and asserts they do
not load belongs in the bot's own test suite, because one missing option
silently restores the unsafe default.

## 2. How an API key is passed to the SDK

**Answer.** Three ways, all usable from the SDK:

1. **Environment variable** (`OPENROUTER_API_KEY`), picked up automatically.
   Observed: `rt.getProviderAuthStatus("openrouter")` →
   `{"configured":true,"source":"environment","label":"OPENROUTER_API_KEY"}`.
   Doc: `docs/providers.md` ("Use an API key from the environment").
2. **`await modelRuntime.setRuntimeApiKey(provider, key)`** — held in memory.
   Observed: it overrides the environment variable (an invalid runtime key
   produced a 401 while a valid key was in the environment) and is not written
   to `auth.json`. Doc: `examples/sdk/09-api-keys-and-oauth.ts`.
3. **`auth.json`** at `ModelRuntime.create({ authPath })`. Not needed in CI.

The CLI also has `--api-key <key>` (Doc: `docs/cli.md`), which would expose
the key in the process list; the subprocess fallback should use the
environment instead.

**For CI.** Pass the secret to the runner process by environment, as C-5
says. Optional hardening: read it once, call `setRuntimeApiKey`, and delete
it from `process.env`, so no later code path in the process can read it from
the environment. With no credentials, the CLI exits 1 before any request
(`subprocess-probe.log`, E).

## 3. Per-step token and cost figures

**Answer.** Every assistant message carries a `usage` object; the
authoritative copy arrives in the `message_end` event
(`event.message.role === "assistant"`). The session total is
`session.getSessionStats()`.

`message.usage` (Source: `pi-ai/dist/types.d.ts:292-320`):

| Field | Meaning |
|---|---|
| `input` | Uncached input tokens (cache reads and writes already subtracted) |
| `output` | Output tokens, including reasoning |
| `cacheRead`, `cacheWrite` | Cached-token counts |
| `reasoning` | Subset of `output`, when the provider reports it |
| `totalTokens` | Sum |
| `cost.input/output/cacheRead/cacheWrite` | Estimates from pi's price catalog |
| `cost.total` | Best available total |
| `cost.totalFromProvider` | `true` when `total` is the billed amount reported by the provider |

Other fields on the same message that the run record needs: `provider`,
`model`, `responseModel`, `stopReason` (`stop`, `toolUse`, `length`,
`error`, `aborted`), `errorMessage`, `durationMs`.

**Observed** (`live-run.log`, section 5; one review step, 7 model calls):

```
step total: in=3395 out=3004 cacheRead=22400 cacheWrite=0 cost=$0.001595 wall=26101ms
session.getSessionStats(): tokens={"input":3395,"output":3004,"cacheRead":22400,"cacheWrite":0,"total":28799} cost=$0.001595 toolCalls=6
```

Summing `message_end` usage equals `getSessionStats()`.

**Caveats for the run record (A-6).**

- **An aborted call reports zero usage** (observed, section 7c). A timed-out
  step therefore under-reports cost; the provider may still bill the partial
  request.
- **`responseModel` is set only when the served id differs from the requested
  id** (Source: `pi-ai/dist/api/openai-completions.js:346-347`). Record
  `responseModel ?? model`. In the live run it was absent, meaning OpenRouter
  echoed `openai/gpt-5-nano`.
- The JSON-mode stream carries the same `message_end` records, so the
  subprocess fallback gets identical figures.

## 4. Exit codes of `-p` and `--mode json`

**Answer** (all observed, `subprocess-probe.log`; pi has no timeout flag, so
"timeout" is the parent killing the child):

| Case | `--mode json` | `-p` (print) |
|---|---|---|
| Success | exit 0; last event `agent_settled` (`aborted:false`) | exit 0 |
| Model error (provider rejects the key, HTTP 401) | **exit 0**; last assistant message has `stopReason:"error"` and `errorMessage` | **exit 1**; error text on stderr |
| Unknown model id | **exit 0**; stderr warns "Using custom model id", the request fails with HTTP 400, `stopReason:"error"` | not run |
| No credentials | exit 1 after the session header; message on stderr | not run |
| SIGTERM (abort) | **exit 143**; stream stops mid-run, no `agent_settled` | exit 143; stderr "Request was aborted" |
| SIGINT | killed by signal (no exit code) | not run |
| SIGKILL (hard timeout) | killed by signal (no exit code) | not run |

Doc agrees: `docs/cli-integration.md` — in JSON mode "a failed or aborted
assistant response … does not by itself produce a nonzero exit status".
Source for 143/129: `dist/modes/print-mode.js:40`.

**Consequence.** With the subprocess fallback the exit code is not a success
signal. Success is: exit 0 **and** an `agent_settled` event **and** a last
assistant `stopReason` of `stop`. A stream without `agent_settled` is a
crashed or killed step.

Other fallback facts observed: the JSONL stream contains
`tool_execution_end` records with `result.details`, so typed findings are
readable from it (case A found one). A short review produced 816 lines, most
of them `message_update` deltas.

## 5. Confining the built-in read tools

**Answer.** pi does not confine them. `cwd` is only the base for relative
paths. `read`, `grep`, `find` and `ls` accept absolute paths, `..`, and `~`
(Source: `dist/core/tools/path-utils.js:42-44`, used at `read.js:200`,
`grep.js:66`, `find.js:66`, `ls.js:40`). Doc: `docs/security.md` — "The
working folder … does not prevent commands from accessing other paths
available to the Pi process."

We do not need our own read tools. The `tool_call` hook can block on the path
argument, and that is enough.

**Observed** with the guard in `spike/extension/review-extension.ts`
(`offline-run.log`, section 3). It resolves the path against `ctx.cwd`,
follows symlinks with `realpath`, and requires the result to be inside the
root:

```
ERR read   "Path \"/etc/hosts\" is outside the snapshot."
ERR read   "Path \"../outside-secret.txt\" is outside the snapshot."
ERR read   "Path \"escape-link\" is outside the snapshot."      (symlink in the snapshot pointing out)
ERR read   "Path \"~/.ssh/id_rsa\" is outside the snapshot."
ERR grep   "Path \"..\" is outside the snapshot."
ERR ls     "Path \"/\" is outside the snapshot."
ok  read   "func (l *Limiter) Allow(…"                          (inside)
```

A blocked call returns the reason to the model as an error result and the run
continues.

**The allowlist guard** (step 3 of the task):

- A tool that is not in `tools` is never declared to the model. If the model
  names it anyway, pi answers `Tool write not found` before any hook runs.
- With `write` and `bash` deliberately activated, the guard rejected both:
  `Tool "write" is not on the review allowlist.` No file was created.
- So the allowlist is enforced twice: by `tools`, and by the guard for
  anything that becomes active by mistake. Doc: a `tool_call` handler that
  throws also blocks the tool (`docs/extensions.md`, "Error Handling").

**Further facts that affect S-4 and C-4.**

- **`grep` needs `rg` and `find` needs `fd` on `PATH`.** If one is missing,
  pi downloads it from GitHub releases into `<agentDir>/bin` at first use
  (Source: `dist/utils/tools-manager.js:216-236`). `PI_OFFLINE=1` prevents
  the download and the tool then fails: observed
  `fd is not available and could not be downloaded`. The review job should
  install both binaries in the action image and set `PI_OFFLINE=1`, so the
  job that holds secrets never downloads and runs a binary.
- **A PR-controlled `.gitignore` can hide files from `grep`.** Observed: with
  no `.git` entry in or above the snapshot, `grep` finds a file listed in
  the snapshot's `.gitignore`; with a `.git` entry present, it does not
  (`read` still works). So the snapshot must not be extracted inside a
  checkout. `find` always applies `.gitignore` (Source: `find.js:133-150`
  passes `--no-require-git` outside a repository); this was not observed
  because `fd` is not installed here. If that is unacceptable, pass custom
  `operations` to `createFindToolDefinition`/`createGrepToolDefinition` or
  override the tool.
- `grep` and `find` do search dot-directories (`--hidden`), so they reach
  `.pi/` and `.github/`.
- Several roots (head, base, module cache): the tools accept absolute paths,
  so the guard only needs a list of allowed roots instead of one. Not tested.
  The guard as written uses `ctx.cwd` alone.
- Patterns (`glob`, `pattern`) only filter inside the search directory, so
  the guard checks the `path` argument only.
- There is no built-in turn cap, step timeout or spend cap. The orchestrator
  enforces them with `session.abort()` (observed: a looping scripted model
  was stopped at the cap; a 300 ms timeout ended the step in 301 ms).

**Contradicts the plan.** F-2 and C-3 describe the guard as an allowlist
check. It must also do path confinement with symlink resolution; that is the
only thing between the model and the runner's filesystem, including the
provider key if it sits in a readable file.

## 6. Behaviour when a tool schema is violated

**Answer.** pi validates arguments against the tool's JSON Schema before
`execute()`. On failure the tool does not run; an error result with the
validation messages is returned to the model, and the loop continues with the
next model call. There is no retry limit of its own: the model simply sees
the error and may try again, bounded by our turn cap.

Source: `pi-ai/dist/utils/validation.js:49-60`,
`pi-agent-core/dist/agent-loop.js:496-498` and the `catch` at `:539-545`.

**Observed, scripted model** (`offline-run.log`, section 3) — the text the
model receives:

```
Validation failed for tool "report_finding":
  - category: missing
  - locations: missing
  …
  - tag: expected one of ["important","nit","pre-existing"]
  - confidence: expected number, got string

Received arguments:
{ … }
```

The scripted model was called again afterwards (7 model calls for 7 scripted
responses).

**Observed, real model** (`live-run.log`): in the review run
`gpt-5-nano` sent one invalid `tag`, received the error, and its next call
was valid (3 findings recorded). In the forced-violation run it was rejected
twice (bad `tag`, then missing `category`) and succeeded on the third call.

**Details that matter for D-4.**

- **Arguments are coerced before validation**: `"0.9"` → `0.9`, `"36"` →
  `36`, a single value → a one-item array (Doc: `docs/extensions.md`, "Tool
  parameter schemas and TypeBox"; observed). The value `execute()` receives
  is the coerced one.
- JSON Schema cannot express cross-field rules, and TypeBox `Refine` is not
  run. Rules such as "`proposedIssue` only when `tag` is `pre-existing`" go
  in `execute()` and are reported by throwing; observed to reach the model as
  an error result the same way.
- The validated finding is read from
  `tool_execution_end.result.details`, never from text. Invalid calls appear
  as `tool_execution_end` with `isError: true` and can be recorded.
- Valid schema does not mean valid content. In the live run one finding's
  `evidence.quote` contained literal `\n` sequences instead of line breaks,
  and `traced` was empty in all three. Mechanical grounding (S-5) is what
  catches the first.
- The error message echoes the full rejected arguments, so each violation
  costs their tokens twice.
- `constrainedSampling` exists as an optional tool field (Doc) and could
  reduce violations on providers that support it. Not tested.

## 7. Several SDK sessions in one process

**Answer.** Safe in the test, with one `ModelRuntime`, `SettingsManager`,
`DefaultResourceLoader` and `SessionManager` per session.

**Observed** (`offline-run.log`, section 4): six sessions were created and
run concurrently with `Promise.all`, each on its own snapshot copy, each
loading the extension by path, with randomised delays in the scripted model.
Every session read its own directory, recorded exactly its own two findings,
and its extension counter ran 1, 2 (extension state is per session).

**Process-wide state to know about** (Source):

- The extension module cache is keyed by cwd and is cleared whenever a
  session with a different cwd loads (`dist/core/extensions/loader.js:91-106`).
  Correct, but concurrent sessions on different directories re-load the
  extension each time. Passing the extension as an in-process factory avoids
  this.
- `process.env` (`PI_OFFLINE`, `PI_CODING_AGENT_DIR`) and the tool binary
  directory are per process.
- An uncaught exception in an extension or tool is shared by all sessions in
  the process. Tool `execute` errors are caught by pi; other failures are
  ours to contain.

Not measured: memory per session, and behaviour above six sessions. If
fan-out later needs isolation between reviewers, the same `AgentStep`
interface can be backed by the subprocess implementation.

## 8. `LICENSE` in `packages/durable`

**Answer.** There is no `LICENSE` file in `packages/durable` on `main`
(`raw.githubusercontent.com/earendil-works/pi/main/packages/durable/LICENSE`
→ 404), and none in the npm tarball of `@earendil-works/pi-durable@1.5.2`
(contents at the top level: `package.json`, `README.md`, `CHANGELOG.md`).
The package's `package.json` declares `"license": "MIT"`, and the repository
root `LICENSE` is MIT ("Copyright (c) 2025 Mario Zechner"). Its README still
opens with "**Experimental.** The API changes without notice between
releases."

Nothing changes for D-3. If F-4 is revisited, ask upstream to add the file
to the package.

## 9. How context files are discovered, and how to turn that off

**Answer.** `loadProjectContextFiles` (Source:
`dist/core/resource-loader.js:129` and `:179-210`):

1. Reads one file from `agentDir` (the global one).
2. Walks from `cwd` **up to the filesystem root**, reading one file per
   directory.
3. In each directory the first existing name wins:
   `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`.
4. The contents go into the system prompt inside
   `<project_instructions path="…">` blocks.

**Project trust does not gate this.** Doc: `docs/security.md` — "Context
files such as `AGENTS.override.md`, `AGENTS.md`, and `CLAUDE.md` load
regardless of project trust unless you disable context loading."

**Turning it off.**

- SDK: `noContextFiles: true` on `DefaultResourceLoader`
  (`resource-loader.js:481-483`). Observed: canary absent from the system
  prompt and from the request sent to the provider.
- CLI: `-nc` / `--no-context-files`.

**Passing the base branch's copy ourselves.** Two options:
`agentsFilesOverride: () => ({ agentsFiles: [{ path, content }] })`, which
keeps pi's `<project_instructions>` framing; or simply include the text in
`context.md` as S-3 already plans. The second keeps knowledge in one place
and is what the spike assumes.

**Contradicts the plan.** C-3 groups `AGENTS.md` with "`.pi/` extensions,
settings or skills" under project trust. They are separate switches. Note
also the walk to the root: an `AGENTS.md` or `CLAUDE.md` in any parent of the
extraction directory (the runner's workspace, a home directory) would be
loaded too.

## 10. OpenRouter through pi: cost, cached tokens, routing

**Per-request cost: yes.** OpenRouter's billed `cost` is read from the
streamed usage and replaces the catalog estimate; `usage.cost.totalFromProvider`
is then `true` (Source: `pi-ai/dist/utils/openrouter-cost.js`; for
bring-your-own-key accounts it adds the upstream inference cost). Observed:
billed on 7 of 7 calls in the review run, for example `cost: 0.00036`.

**Cached tokens: yes.** `prompt_tokens_details.cached_tokens` →
`usage.cacheRead`; `cache_write_tokens` → `usage.cacheWrite`
(Source: `pi-ai/dist/api/openai-completions.js:1161-1162`). Observed
`cacheRead` per call: `0, 2048, 2688, 3968, 4096, 4736, 4864`. pi sends
`prompt_cache_key` and OpenRouter session-affinity headers by default, so
the shared prefix was cached without any work on our side.

**Provider routing preferences: yes.** Set `compat.openRouterRouting` on the
model; pi sends it as the request body's `provider` field
(Source: `openai-completions.js:721-722`; Doc: `docs/models-configuration.md`,
`openRouterRouting`). Two ways to set it:

- In code, on a copy of the model object:
  `{ ...model, compat: { ...model.compat, openRouterRouting: { sort: "price" } } }`.
  Observed in the request body: `provider={"sort":"price"}`.
- In `models.json` (`modelOverrides`), if configuration by file is preferred.

Fields such as `only`, `order`, `data_collection: "deny"` and `zdr` are
OpenRouter's and pass through unchanged; only `sort` was sent in the test.
This lets the bot carry an owner's routing choice per role, in addition to
the provider-side enforcement that C-6 relies on.

**Other observations.**

- Request body keys sent: `model, messages, stream, prompt_cache_key,
  prompt_cache_retention, stream_options, store, max_completion_tokens,
  tools, reasoning, provider`. `store` is set to `false`
  (`openai-completions.js:576`).
- Model catalog: 403 OpenRouter chat models are known offline. With a key,
  pi can restrict the list to what the key may use (`/models/user`), but
  only on a catalog refresh, which `PI_OFFLINE=1` disables. A model the key
  does not allow therefore fails at request time with `stopReason:"error"`,
  which matches C-6 ("treats a refused model as a configuration error").
- In the SDK, an unknown id makes `modelRuntime.getModel()` return
  `undefined`, so the orchestrator can fail before prompting. The CLI instead
  proceeds with a "custom model id" and fails at the provider.
- A 401 was **not** retried by pi's automatic retry (`retries=[]`); retry
  applies to errors pi classifies as transient. `session.prompt()` does not
  throw on a model error: it resolves, and the last assistant message has
  `stopReason:"error"`.

---

## Other things the spike turned up

- **pi ships a scripted ("faux") model provider**:
  `fauxProvider()`, `fauxAssistantMessage()`, `fauxToolCall()` from
  `@earendil-works/pi-ai`, registered with
  `modelRuntime.registerNativeProvider()`. The offline half of the spike runs
  on it. It makes the "scripted (for tests)" `AgentStep` of A-2 unnecessary
  as a separate implementation: tests can run the real SDK step, real
  extension and real guard against scripted model output, with no network.
- `agent_settled` exists as described in F-2 and is the right completion
  signal; `agent_end` can be followed by a retry.
- Tool calls in one assistant message run in parallel by default, so
  `tool_execution_end` order is completion order. `report_finding` is marked
  `executionMode: "sequential"` in the spike to keep findings in call order.
- `await session.bindExtensions({ mode: "json" })` is called after creation
  so extension handlers get a context with `hasUI: false`, as the CLI's own
  JSON mode does (`dist/modes/print-mode.js:60`).
- pi 1.5.2 pulls 123 packages, including a TUI and an MCP client that the bot
  does not use. Install with `npm ci --ignore-scripts`; the spike ran with
  install scripts disabled throughout.

## Suggested changes to the plan

Not applied; `docs/plan/` was left untouched apart from this file.

| Where | Change |
|---|---|
| C-3, "The PR cannot load code into pi" | Name the mechanism: SDK sessions are created with `projectTrusted: false` (in-memory settings), `noContextFiles`, `noExtensions` plus an explicit extension, `noSkills`, and a private `agentDir`. Add: a regression test plants hostile files and asserts none load |
| C-3, "The model cannot change anything" | The guard also confines every path argument to the allowed roots after resolving symlinks |
| C-4, review job | `rg` and `fd` are installed in the action image; `PI_OFFLINE=1`; the snapshot is extracted outside any directory that has a `.git` entry or an `AGENTS.md`/`CLAUDE.md` in a parent |
| F-2 | Add `before_provider_request` (request capture for records) and the faux provider (tests). `tool_call` row: allowlist **and** path confinement |
| F-3, fallback | Success in JSON mode is `agent_settled` plus `stopReason`, not the exit code |
| A-6, usage | Aborted calls report zero usage; served model is `responseModel ?? model`; store `cost.totalFromProvider` |
| S-4 | `.gitignore` handling of `grep`/`find` is a known limitation or is overridden |
| S-5 | Schema validity is already enforced by pi at call time; the orchestrator re-validates only as defence in depth |
| R-0 | The spike used a synthetic snapshot, not a cass-operator PR |

New open questions for [07-roadmap](07-roadmap.md#open-questions):

- **Q-14.** Should `grep`/`find` ignore the snapshot's `.gitignore`
  (override the tools) or is hiding ignored files acceptable?
- **Q-15.** Is the extension loaded by path (the pi-package shape, also used
  by `/review`) or passed in-process by the runner (no jiti, configuration by
  closure)? Both work; the runner could do the second while the package keeps
  the first.
- **Q-16.** How is the cost of timed-out steps recorded, given that aborted
  calls report no usage?

---

## Recommendation

### SDK or subprocess

**Use the SDK.** Every item in the R-0 deliverable works through it, so the
fallback was not needed; it was run only to answer question 4.

| | SDK | Subprocess (`pi --mode json`) |
|---|---|---|
| Typed findings | `tool_execution_end.result.details`, in process | Same record, parsed from JSONL |
| Trust isolation | Explicit options; unsafe by default | `--no-approve -nc -ne -ns -np`; safe by default in JSON mode |
| Key handling | In-memory `setRuntimeApiKey` | Environment of the child |
| Limits | `session.abort()`, turn counting on events | Kill the child; no `agent_settled` afterwards |
| Error signal | `stopReason` on the last message | Same, plus an exit code that is 0 on model errors |
| Routing, request capture | Model object, inline hook | `models.json`, extension file |
| Tests | Faux provider in process | Needs a fake endpoint |
| Fault isolation | Shared process | Per step |

The subprocess form stays viable behind the same interface and is the
answer if reviewer fan-out ever needs per-step fault isolation.

### Version to pin

`"@earendil-works/pi-coding-agent": "1.5.2"` — exact, with the lockfile
committed and `npm ci --ignore-scripts` in CI. `engines.node` is
`>=22.19.0`. If the bot imports `@earendil-works/pi-ai` directly (faux
provider in tests), pin it to the same `1.5.2`. pi releases roughly weekly
(1.1.0 on 2026-10-07 to 1.5.2 on 2026-11-10), so upgrades go through the
eval harness as F-6 already says.

### Proposed `AgentStep` interface

Lives in `agent/`, imports only `core` types. It never throws for anything
the model or provider does; those are outcomes.

```ts
// core: one entry per typed output tool. Schemas (JSON Schema / TypeBox) live in core
// and are shared by the pi extension and by the orchestrator's own re-validation.
export interface OutputTools {
  report_finding: ProducerFinding;    // A-3, producer-set fields
  ask_question: Question;
  note_needs_human: NeedsHumanNote;
  submit_verdict: Verdict;
}
export type ToolOutput = {
  [K in keyof OutputTools]: { tool: K; value: OutputTools[K] };
}[keyof OutputTools];

export interface ModelRef {
  provider: string;                   // "openrouter"
  id: string;                         // "openai/gpt-5-nano"
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
  routing?: Record<string, unknown>;  // provider routing preferences, passed through
}

export interface AgentStepRequest {
  role: "reviewer" | "verifier" | "learner";
  model: ModelRef;
  systemPrompt: string;               // the method; replaces pi's default prompt
  prompt: string;
  roots: { head: string; base?: string; modcache?: string }; // absolute, read-only; head is the cwd
  readTools: ReadonlyArray<"read" | "grep" | "find" | "ls">;
  outputTools: ReadonlyArray<keyof OutputTools>;
  limits: {
    timeoutMs: number;                // whole step
    idleTimeoutMs?: number;           // no event for this long
    maxTurns: number;                 // model calls
    maxCostUsd?: number;              // checked after each model call
  };
  signal?: AbortSignal;               // run cancellation (newer push)
  onProgress?: (p: { turns: number; costUsd: number; lastTool?: string }) => void; // heartbeat (C-8)
}

export interface StepUsage {
  turns: number;
  input: number;
  output: number;                     // includes reasoning
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  costUsd: number;
  costIsBilled: boolean;              // false when any call's cost is a catalog estimate
  wallMs: number;
}

export interface AgentStepResult {
  outcome: "ok" | "timeout" | "error" | "truncated" | "cancelled";
  // truncated: turn cap, cost cap, or the model's output limit. Outputs so far are kept.
  error?: { kind: "provider" | "config" | "internal"; message: string };
  outputs: ToolOutput[];              // validated, in call order
  rejectedCalls: Array<{ tool: string; reason: string }>; // schema violations and guard blocks
  usage: StepUsage;
  servedModels: string[];             // responseModel ?? model, distinct, per call
  harness: { name: "pi-sdk" | "pi-subprocess" | "scripted"; version: string };
}

export interface AgentStep {
  run(request: AgentStepRequest): Promise<AgentStepResult>;
}
```

Mapping to what was observed: `outputs` come from
`tool_execution_end.result.details`; `rejectedCalls` from
`tool_execution_end` with `isError`; `usage` from `message_end`;
`outcome` from the limit that fired or the last `stopReason`
(`error` → `error`, `length` → `truncated`); `roots` feed both the session
`cwd` and the guard's allowed roots.

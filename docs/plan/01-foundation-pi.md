# 01 — Foundation: pi

Facts here come from pi's repository and docs as read on 2026-11-15 (see
[08-research-notes.md](08-research-notes.md#pi)). Items in
[F-6](#f-6--to-verify-in-the-phase-0-spike) were not confirmed and must be
checked before code depends on them.

## F-1 — What pi is

- Repository: `github.com/earendil-works/pi` (monorepo; formerly
  `badlogic/pi-mono`, moved to Earendil Works around May 2026).
- CLI package: `@earendil-works/pi-coding-agent`, version 1.5.2 at time of
  writing. License **MIT**. Requires Node `>=22.19.0`.
- Four modes: interactive TUI, print/JSON, RPC, and SDK.
- Deliberately minimal: **no built-in sub-agents, plan mode, or permission
  prompts.** Those are built with extensions. This suits us: nothing to
  disable for unattended operation, and orchestration is ours to define.

## F-2 — Extension surfaces we use

| Surface | Use |
|---|---|
| `pi.registerTool` | `report_finding`, `ask_question`, `note_needs_human`, `submit_verdict` — the typed output channel ([A-3](02-architecture.md#a-3--finding)); read-only snapshot, history and issue-search tools |
| Built-in OpenRouter provider (`OPENROUTER_API_KEY`) | First model provider ([C-6](06-ci-and-security.md#c-6--model-provider)) |
| `pi.on("tool_call", …)` | Reject any tool not configured for the role, called by the model or by another tool, **and confine the path argument of `read`, `grep`, `find` and `ls`** to the allowed roots after resolving symlinks, whoever implements them. pi itself does not confine its read tools |
| `pi.on("before_provider_request", …)` | Capture what was sent, for run records |
| Scripted ("faux") model provider in `@earendil-works/pi-ai` | Tests run the real SDK step, extension and guard against scripted model output, with no network |
| `pi.on("agent_settled", …)` | Know when a session has truly finished |
| `pi.registerCommand` | `/review-bot`: the pipeline's entry point, in CI and interactively |
| `pi.registerFlag` | Headless options when run through the pi CLI |
| Skills (`SKILL.md`) | Review method instructions, loaded on demand |
| Package manifest (`pi.extensions`, `pi.skills`, `pi.prompts`) | Distribution: `pi install npm:…` or `git:…` |
| `createCodemodeExtension`, `createToolSearchExtension`, `createMcpExtension` | pi's built-in extensions, which SDK sessions do not include. Registered inactive in every role session |
| `pi.registerMcpServer` / other pi packages | Integrations (issue trackers, chat, docs) without changing our core |
| `settings.json` `packages`, `models.json` in an operator agent directory | Providers, endpoints, model overrides, any pi module and the bot's settings, all by configuration ([F-7](#f-7--configuration-follows-pi)) |

Extensions are TypeScript loaded through jiti, so no build step is required
for the extension itself.

## F-3 — Integration shape

The whole bot is a pi module, `pi-review`: extension + skill + prompts +
the `/review-bot` command, installable into any pi setup.

Two separate choices ([D-2](README.md#key-decisions)):

1. **How a model step runs: the SDK.** The orchestrator creates one
   short-lived session per step (`createAgentSession`), each with an
   explicit model, tool set and in-memory session manager. The extension is
   loaded into those sessions to provide the typed tools, next to the
   operator's modules ([F-7](#f-7--configuration-follows-pi)). Decided by
   the R-0 spike. The SDK is unsafe by default with untrusted code and must
   be isolated explicitly ([C-3a](06-ci-and-security.md#c-3a--pi-session-isolation)).
2. **What starts the orchestrator: a pi command.** CI and developers both
   run `/review-bot`. Jobs without a model (`gate`, `prepare`,
   `complete-check`) and the offline jobs stay plain `review-bot` CLI
   commands and do not start pi.

Why code owns orchestration rather than a single long pi session steering
itself: [P-3](README.md#principles). The command is ordinary TypeScript.
Flow in code is testable, cheap, and cannot be talked out of a step by PR
content.

**Running as a command in CI.** pi's headless mode does not report failure
by itself ([evidence](r1a-proposal.md#behaviour-as-a-module-without-a-host)),
so every row is required and tested:

| pi's behaviour | What we do |
|---|---|
| A command that throws exits 0 | The command sets the exit code. `complete-check` also ends an unfinished check as *neutral* after exit 0 |
| An unknown or ambiguous command is sent to the model as a prompt | Start with `-ne -e <path to pi-review>`: a missing path exits 1 and nothing can shadow the command. Operator modules load in role sessions |
| SIGTERM exits without waiting for the command | `session_shutdown` awaits the pipeline, which publishes what it has |
| `console.log` from a module goes to stderr | The result is written with `--out` |
| A malformed `settings.json` is a warning | The command validates it and stops with a configuration error |
| A missing package is skipped when offline | The command checks every listed package and stops with a configuration error |
| pi waits while stdin is open | Start it with stdin closed |
| The project can be trusted by any module's handler | `--no-approve`, and an empty working directory |

The subprocess form (`pi --mode json --no-session -e <extension> -t <tools>
--model <id>`) stays possible behind the same `AgentStep` interface
([A-2](02-architecture.md#a-2--modules)) and is the answer if fan-out ever
needs per-step fault isolation. If used: its exit code is **not** a success
signal — `--mode json` exits 0 on a model error. Success is exit 0, an
`agent_settled` event, and a final `stopReason` of `stop`.

pi has no built-in turn cap, step timeout or spend cap. The orchestrator
enforces all three by counting events and calling `session.abort()`.

Sub-agents: there is no pi primitive, so "reviewer fan-out" is simply several
`AgentStep`s run concurrently by the orchestrator.

## F-4 — Pi Durable decision

What it is: `@earendil-works/pi-durable` (MIT per npm metadata, same
monorepo), released with Pi 1.0. A checkpointed conversation/task runtime:
every model request, tool call and compaction is a task with a stored
checkpoint; after a crash unfinished tasks resume. Storage backends are
memory, SQLite file, JSONL directory, Durable Objects, IndexedDB. It is not a
DAG workflow engine. Its README states it is **experimental and the API
changes without notice between releases**.

**Decision (D-3): do not build on it now.**

- A review run is minutes long and idempotent. In CI the recovery strategy
  for a crash is "re-run the job", which costs little and needs no storage.
- Its file-backed storage does not survive a fresh ephemeral runner unless we
  add artifact save/restore, which is more machinery than re-running.
- An API that changes without notice is a poor base for a tool whose value
  depends on stable, comparable behaviour across months of runs.

**What we do instead:** keep each stage's input and output as serializable
values written to the run directory ([S-0](03-review-pipeline.md#s-0--run-directory)).
That gives resumability-by-stage for debugging and replay, and it is exactly
the seam where Pi Durable could later slot in.

**Revisit when** any of these becomes true: the bot runs as a long-lived
service rather than per-PR CI jobs; runs become long enough that re-running
is expensive (for example dynamic testing of the PR); or Pi Durable declares
a stable API.

## F-5 — Existing pi review work (reference, not base)

- `earendil-works/pi-review` (official, MIT): interactive `/review pr N`.
  No headless mode. Worth reading for prompt and `gh` usage.
- `shaftoe/pi-coding-agent-action` (community, MIT): a GitHub Action wrapping
  pi. Note its documented behaviour of always trusting the project in CI,
  which loads `.pi/` extensions and `AGENTS.md` from the checkout. That is
  the exact hazard [C-3](06-ci-and-security.md#c-3--trust-model) forbids,
  and it rules the action out for fork PRs.
- `pi-pr-review` (community npm): advertises parallel reviewers.

We read these for ideas. We do not depend on them.

## F-6 — To verify in the Phase 0 spike

**Status: all ten answered** on 2026-11-15 against pi 1.5.2, with evidence,
in [spike-r0-findings.md](spike-r0-findings.md). Short answers: (1) yes, but
only with explicit options — SDK defaults trust the project; (2) environment
variable or an in-memory runtime key; (3) `message_end` → `message.usage`,
totals from `session.getSessionStats()`; (4) `--mode json` exits 0 on model
errors; (5) not confined by pi — our guard checks paths; (6) the validation
error is returned to the model, which is called again; (7) safe in the test,
six in parallel; (8) no file, `package.json` says MIT; (9) walks from cwd to
the filesystem root, not gated by project trust, off with `noContextFiles`;
(10) billed cost, cached tokens and routing preferences all work. Not
covered: Linux, Node 22, `find` (no `fd` binary on the test machine), more
than one read root.

| # | Question | Why it matters |
|---|---|---|
| 1 | Can `createAgentSession` load our extension explicitly (via `resourceLoader`) while loading **nothing** from the working directory (`.pi/`, project skills, `AGENTS.md`)? | Trust model |
| 2 | How is an API key passed to the SDK — option, env, or only `auth.json`? | CI secrets |
| 3 | Per-step token and cost figures: which event/field carries them? | Run records |
| 4 | Exit codes of `-p` / `--mode json` on model error, timeout, abort | Fallback path |
| 5 | Can pi's built-in read/grep/find tools be confined to given root directories (head snapshot, base snapshot, module cache), or do we register our own? There is no `.git` in the review job, so history tools are ours regardless | Tool allowlist |
| 6 | Behaviour when a tool schema is violated: is the model re-prompted? | Typed output reliability |
| 7 | Concurrency: several SDK sessions in one process — safe, or use processes? | Fan-out |
| 8 | Is there a `LICENSE` file in `packages/durable` (npm says MIT)? | Only if F-4 is revisited |
| 9 | How context files (`AGENTS.md`) are discovered, and how to turn that off — we pass the base branch's copy ourselves | Trust model |
| 10 | OpenRouter through pi: are per-request cost and cached-token figures reported? Can provider routing preferences be set? | Run records, privacy |

Pin pi to exactly **1.5.2** in `package.json`, lockfile committed, installed
with `npm ci --ignore-scripts`. pi releases roughly weekly; upgrades go
through the isolation regression test and the replay harness like any other
change.

## F-7 — Configuration follows pi

**Decision ([D-18](README.md#key-decisions)):** the bot is configured as
any pi module is. Everything pi has a configuration concept for uses pi's
own files and format; the bot's options are one key in the same file.
Adding a provider, an endpoint or **any pi module** — tools, hooks,
orchestrators such as codemode, MCP servers — is a configuration change,
never a code change or a bot release.

**The operator's pi agent directory.** The runner is given an agent
directory with pi's standard layout (`docs/configuration.md` in the pi
package, "Agent directory"), the same one a developer can point `pi` at locally:

| File | Holds | Replaces |
|---|---|---|
| `settings.json` | `packages` (pi modules to load), `enabledModels` (which models the repository may pick), settings of pi's built-ins such as `codemode`, and `reviewBot` (the bot's own settings) | Most workflow inputs |
| `models.json` | Custom providers and endpoints, extra model ids, `modelOverrides` (prices, context, thinking maps), `compat.openRouterRouting` for upstream-provider restrictions | Our `providers` and `routing` role fields, and the "custom id" fallback for models missing from pi's catalog where an operator wants real prices |
| `auth.json` | Not used in CI. Keys come from environment variables, or `"apiKey": "$NAME"` in `models.json` | — |

Running `pi --list-models` with `PI_CODING_AGENT_DIR` set to that directory
shows exactly what the bot can use, and `/review-bot` inside pi uses the
same configuration.

Where it comes from: a path in the consumer's **default branch**, or an
organization configuration repository pinned to a commit, named by a
workflow input. **Never from the PR**, neither its head nor its base: pi
packages execute code, and `models.json` can run a command
(`"apiKey": "!cmd"`).

**Bot settings** are the `reviewBot` key of `settings.json`. pi keeps
unknown keys when it rewrites the file and extensions read them with
`pi.getSettings()` ([Q-20](07-roadmap.md#open-questions)).

```json
{
  "packages": ["npm:@org/pi-x@1.2.3"],
  "enabledModels": ["openrouter/vendor/*"],
  "codemode": { "mode": "on" },
  "reviewBot": {
    "roles": {
      "reviewer": { "model": "openrouter/vendor/model:high", "tools": ["+codemode"] },
      "verifier": { "model": "openrouter/vendor/other" }
    },
    "limits": { "runCostUsd": 5 }
  }
}
```

- **Role → model** uses pi's model syntax: `provider/id`, with an optional
  `:<thinking>` suffix, as pi's `--model` takes it. The bot-specific
  `thinking`, `providers` and `routing` fields are removed in favour of the
  suffix and `models.json`.
- **Role → tools** uses pi's `defaultTools` syntax, relative to the role's
  read-only default ([S-4](03-review-pipeline.md#s-4--review)). pi's own
  default, which has `bash`, is never inherited.
- The key also holds step and run limits, skip rules, the authorization
  label, CI wait ([C-9](06-ci-and-security.md#c-9--waiting-for-ci)) and
  metrics export ([O-2](10-metrics.md#o-2--how-the-numbers-are-collected)).
  The gate reads it as plain JSON, without loading pi.

**Precedence:** `settings.json`, overridden by workflow inputs (both are
the maintainers'), narrowed by the base branch's `.review/review-bot.yaml`.
The base branch need not be the default one, so that file can only narrow
what the first two allow: choose among `enabledModels` (without that list it cannot
change a model) and lower limits. It can never name tools, packages,
providers or endpoints. Skip rules, CI wait and the authorization label
are the repository's own policy and may be set there as before.

### Adding a pi package without code changes

Two equivalent ways, both pinned:

1. **pi's own sources** in `settings.json` `packages`:
   `npm:@scope/pi-provider-x@1.2.3` or `git:github.com/org/pkg@<commit>`.
   Ranges and branch names are rejected; the version is the pin.
2. **The runner's own `node_modules`**: add the package to the
   `package.json` next to the agent directory (npm or pnpm, lockfile
   committed) and list it as a local source,
   `./node_modules/@scope/pi-provider-x`. An installed package is loaded
   only when listed; installing is not configuring, so a transitive
   dependency that happens to be a pi package never loads by itself.

A local source must resolve outside every read root, so no path can point
into the snapshot.

**Installation happens before any secret is present.** The review job
runs with `PI_OFFLINE=1` and downloads nothing
([C-3a](06-ci-and-security.md#c-3a--pi-session-isolation)). Packages are
installed by `review-bot setup` (pi's package manager, or `npm ci` /
`pnpm install --frozen-lockfile`, scripts disabled either way) in a step
that has no secrets, or baked into the action image. The review step then
finds them already installed and fails as a configuration error if one is
missing.

**What a module can do in a review: anything pi allows.** Modules are
trusted code running in the job that holds the model key and the GitHub
token ([D-19](README.md#key-decisions)); review their source as for any
dependency.

| Contribution | Effect |
|---|---|
| Providers (`pi.registerProvider`), models | Available to roles, like built-in ones |
| Tools | Active when named in the role's `tools`, and then also callable from other tools such as codemode. A tool not in that set cannot be called either way |
| A tool with the name of one of the bot's | Replaces it, and the run record says so. Path checks stay on the names `read`, `grep`, `find` and `ls`. Replacing an output tool gives up [D-4](README.md#key-decisions)'s guarantee |
| Skills, prompt templates | Not discovered into model steps; the method is the bot's ([A-5](02-architecture.md#a-5--knowledge-sources)). A module can still change the prompt through hooks |
| Event hooks (`before_provider_request` …) | Run in each role session, and can see and change prompts, calls and responses |

A module that gives the model a shell, network access or an unconfined
reader also gives it to whoever writes the PR, through prompt injection.
That is the maintainers' decision: the defaults have none, the installing
guide says so, and the review summary lists the extra tools that were
active.

Every loaded package and its resolved version goes in the run record, and
adding or upgrading one is a change replayed under
[E-5](05-evaluation.md#e-5--acceptance-procedure) like a model change.

### Codemode

pi's built-in `codemode` tool lets the model write a script that calls the
role's other tools in a sandbox without file system, network or process
access. It is enabled like any tool (`"+codemode"`). It needs:

- the guard to allow configured tools when another tool calls them, with
  the same path checks;
- accounting to add the usage on tool results (`models.classify()` and
  other nested calls), so it counts toward the spend cap;
- step and idle timeouts as the bound on scripts, which have no deadline
  of their own and whose nested calls are not turns;
- the method prompt to work with `codemode.mode: only`, which hides the
  other tools' declarations.

The scripts are saved for later evaluation
([A-6](02-architecture.md#a-6--run-record), [R-6](07-roadmap.md#r-6--promotion-to-checks)).

### What does not change

Nothing from the **PR** is executed or becomes configuration
([C-3](06-ci-and-security.md#c-3--trust-model)): project trust stays off
and the snapshot's `.pi/` and context files are never loaded. Because
modules and the programs they start take configuration from the working
directory, that directory is never the snapshot. The live isolation check
becomes "the loaded extensions are ours, pi's built-ins and exactly the
listed packages; the active tools equal the role's configured set; the
project is untrusted; the working directory is outside every read root".

ACP agents ([A-2](02-architecture.md#a-2--modules)) keep their own
`--acp-agent` configuration and workspace for now. If ACP is later offered
as a pi provider package, it moves into `settings.json` like any other.

### To verify before implementing (pi 1.5.2)

| # | Question | Status (probed 2026-11-22, macOS) |
|---|---|---|
| 1 | Does the SDK's resource loader load `packages` from the agent directory's `settings.json` while project trust is off, and with `PI_OFFLINE=1` from an already-installed copy? | Yes for a local path. npm and git sources not tested |
| 2 | Can package installation run with lifecycle scripts disabled (pi's package manager, or plain npm/pnpm into a local source)? | **Open.** pi's npm arguments do not disable them, so setup has to |
| 3 | Does pi tolerate unknown keys in `settings.json`, or must bot settings stay in a separate file? | Yes: kept on rewrite and readable by extensions |
| 4 | With `PI_OFFLINE=1`, does OpenRouter's per-key model list (`/models/user`) still apply, and are `models.json` additions merged with the built-in catalog? | **Open** |
| 5 | Does a package's tool registration stay inactive when the session's tool list does not name it? | Yes, and a codemode script cannot call it |

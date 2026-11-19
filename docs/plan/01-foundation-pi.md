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
| `pi.on("tool_call", …)` | Reject any tool not on the stage's allowlist, **and confine every path argument** to the allowed roots after resolving symlinks. pi itself does not confine its read tools |
| `pi.on("before_provider_request", …)` | Capture what was sent, for run records |
| Scripted ("faux") model provider in `@earendil-works/pi-ai` | Tests run the real SDK step, extension and guard against scripted model output, with no network |
| `pi.on("agent_settled", …)` | Know when a session has truly finished |
| `pi.registerCommand` | `/review` for local, interactive use of the same pipeline |
| `pi.registerFlag` | Headless options when run through the pi CLI |
| Skills (`SKILL.md`) | Review method instructions, loaded on demand |
| Package manifest (`pi.extensions`, `pi.skills`, `pi.prompts`) | Distribution: `pi install npm:…` or `git:…` |
| `pi.registerMcpServer` / other pi packages | Later integrations (issue trackers, chat, docs) without changing our core |
| `settings.json` `packages`, `models.json` in an operator agent directory | Providers, endpoints, model overrides and pi packages added by configuration ([F-7](#f-7--configuration-follows-pi)) |

Extensions are TypeScript loaded through jiti, so no build step is required
for the extension itself.

## F-3 — Integration shape

Two artifacts, one codebase:

1. **A pi package** (`pi-review`): extension + skills + prompts. Installable
   into any pi setup. Gives interactive users `/review`.
2. **A runner** (`review-bot` CLI): our orchestrator. It embeds pi through the
   SDK (`createAgentSession`) and creates one short-lived session per model
   step, each with an explicit model, tool allowlist, and in-memory session
   manager. The extension is loaded into those sessions to provide the typed
   tools.

Why the runner owns orchestration rather than a single long pi session
steering itself: [P-3](README.md#principles). Flow in code is testable,
cheap, and cannot be talked out of a step by PR content.

**Decided by the R-0 spike: the SDK.** Everything needed works through it.
The SDK is unsafe by default with untrusted code and must be isolated
explicitly ([C-3a](06-ci-and-security.md#c-3a--pi-session-isolation)).

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

**Decision ([D-18](README.md#key-decisions)):** everything pi already has
a configuration concept for is configured in pi's own files, in pi's own
format. The bot invents configuration only for what pi does not have.
Adding a provider, an endpoint or a pi package is a configuration change,
never a code change or a bot release.

**The operator's pi agent directory.** The runner is given an agent
directory with pi's standard layout (`docs/configuration.md` in the pi
package, "Agent directory"), the same one a developer can point `pi` at locally:

| File | Holds | Replaces |
|---|---|---|
| `settings.json` | `packages` (pi packages to load), `enabledModels` (which models the repository may pick) | — |
| `models.json` | Custom providers and endpoints, extra model ids, `modelOverrides` (prices, context, thinking maps), `compat.openRouterRouting` for upstream-provider restrictions | Our `providers` and `routing` role fields, and the "custom id" fallback for models missing from pi's catalog where an operator wants real prices |
| `auth.json` | Not used in CI. Keys come from environment variables, or `"apiKey": "$NAME"` in `models.json` | — |

Running `pi --list-models` with `PI_CODING_AGENT_DIR` set to that directory
shows exactly what the bot can use, and `/review` inside pi uses the same
providers.

Where it comes from: a path in the consumer's default branch, or an
organization configuration repository, named by a workflow input. **Never
from the PR**, and never from `.review/review-bot.yaml`: pi packages
execute code, and `models.json` can run a command (`"apiKey": "!cmd"`).

**Role → model** uses pi's model syntax: `provider/id`, with an optional
`:<thinking>` suffix, as pi's `--model` takes it. The bot-specific
`thinking`, `providers` and `routing` fields are removed in favour of the
suffix and `models.json`.

**Bot settings** — what pi has no concept for — stay in the bot's own
file: roles, step and run limits, skip rules, authorization label, CI wait
([C-9](06-ci-and-security.md#c-9--waiting-for-ci)), metrics export
([O-2](10-metrics.md#o-2--how-the-numbers-are-collected)). Workflow inputs
first, then the base branch's `.review/review-bot.yaml`, which can choose
only among `enabledModels` and lower limits, not raise them past the
operator's.

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

**Installation happens before any secret is present.** The review job
runs with `PI_OFFLINE=1` and downloads nothing
([C-3a](06-ci-and-security.md#c-3a--pi-session-isolation)). Packages are
installed by `review-bot setup` (pi's package manager, or `npm ci` /
`pnpm install --frozen-lockfile` with scripts disabled) in a step that has
no provider key, or baked into the action image. The review step then
finds them already installed and fails as a configuration error if one is
missing.

**What a package can do in a review.** Packages are operator-trusted code
running in the job that holds the model key; review their source as for
any dependency.

| Contribution | Effect |
|---|---|
| Providers (`pi.registerProvider`), models | Available to roles, like built-in ones. The main use |
| Tools | **Not** active in model steps unless the operator names them in a role's extra tool allowlist. Path confinement does not cover what they do |
| Skills, prompt templates | Not loaded into model steps; the review method is the bot's ([A-5](02-architecture.md#a-5--knowledge-sources)) |
| Event hooks (`before_provider_request` …) | Run, and see prompts and responses. Inherent to trusted code |

Every loaded package and its resolved version goes in the run record, and
adding or upgrading one is a change replayed under
[E-5](05-evaluation.md#e-5--acceptance-procedure) like a model change.

### What does not change

Isolation from the **PR** is exactly as before: project trust stays off,
the snapshot's `.pi/` and context files are never read, and the active
tools must equal the allowlist. What changes is the source of trusted
configuration: an operator directory instead of an empty one. The live
isolation check becomes "the loaded extensions are ours plus exactly the
listed packages".

ACP agents ([A-2](02-architecture.md#a-2--modules)) keep their own
`--acp-agent` configuration for now. If ACP is later offered as a pi
provider package, it moves into `settings.json` like any other.

### To verify before implementing (pi 1.5.2)

| # | Question |
|---|---|
| 1 | Does the SDK's resource loader load `packages` from the agent directory's `settings.json` while project trust is off, and with `PI_OFFLINE=1` from an already-installed copy? |
| 2 | Can package installation run with lifecycle scripts disabled (pi's package manager, or plain npm/pnpm into a local source)? |
| 3 | Does pi tolerate unknown keys in `settings.json`, or must bot settings stay in a separate file? (Plan assumes separate.) |
| 4 | With `PI_OFFLINE=1`, does OpenRouter's per-key model list (`/models/user`) still apply, and are `models.json` additions merged with the built-in catalog? |
| 5 | Does a package's tool registration stay inactive when the session's tool list does not name it? |

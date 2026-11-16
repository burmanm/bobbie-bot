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

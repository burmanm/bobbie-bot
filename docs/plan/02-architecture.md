# 02 — Architecture

## A-1 — Overview

Three jobs share one codebase and one set of data contracts:

```
            ┌────────────────────── review job (per PR push) ──────────────────────┐
PR event ──▶│ intake ▶ deterministic pass ▶ context ▶ review ▶ verify ▶ reconcile ▶ publish │──▶ PR review + check run
            └───────────────────────────────┬──────────────────────────────────────┘
                                            ▼
                                  run record (workflow artifact)
                                            │
            ┌──────── harvest job (scheduled) ────────┐   ┌── store ──┐
GitHub  ───▶│ collect artifacts + finding outcomes    │──▶│ runs      │
            └──────────────────────────────────────────┘   │ outcomes  │
                                                           └─────┬─────┘
            ┌──────── learn job (scheduled) ──────────┐          │
            │ cluster ▶ propose ▶ validate by replay  │◀─────────┘
            └───────────────────┬─────────────────────┘
                                ▼
          PR to REVIEW.md / lint config / CI check (code owner merges)
```

The review job is the only one on the PR's critical path. Harvest and learn
are offline ([D-9](README.md#key-decisions)). The surrounding approval flow
(state labels, human review requests) is not part of the bot
([09](09-process-integration.md#i-1--what-lives-where)).

## A-2 — Modules

Dependency direction is strictly downward. `core` knows nothing about pi or
GitHub, which keeps most logic unit-testable without a model or network.

| Module | Responsibility | May import |
|---|---|---|
| `core` | Types and schemas, diff parsing, skip-path handling, fingerprinting, dedupe, grounding checks, knowledge loading, summary assembly, run-record format | — |
| `agent` | `AgentStep` interface: run one model step with a role, prompt, read roots, tool allowlist and limits; return typed tool outputs, rejected calls, usage and outcome. Signature proposed in [spike-r0-findings.md](spike-r0-findings.md#proposed-agentstep-interface). Implementation: pi SDK (subprocess possible later). Tests use the same implementation with pi's scripted model provider | `core` |
| `pi-review` (pi package) | Extension: typed tools, tool-call guard, `/review` command. Method skill and prompt templates | `core` |
| `platform` | `Platform` interface: fetch PR and comments, check runs, publish review and replies, read outcomes. Implementation: GitHub | `core` |
| `store` | `Store` interface: append/read run records, outcomes and per-PR metrics records; `MetricsSink` for optional export ([O-2](10-metrics.md#o-2--how-the-numbers-are-collected)) | `core` |
| `pipeline` | The stages in [03](03-review-pipeline.md) | all above |
| `learn` | Harvest and learning jobs ([04](04-learning-loop.md)) | all above |
| `eval` | Replay harness and mechanical diff ([05](05-evaluation.md)). No judging | all above |
| `cli` | `review-bot review | harvest | learn | eval` | all above |

Interfaces that exist so they can be swapped later: `AgentStep` (pi SDK ↔
subprocess ↔ Pi Durable), `Platform` (GitHub ↔ GitLab), `Store` (git
repository ↔ object storage).

Start with one package and folders; split into npm packages only if needed.

## A-3 — Finding

The central data type. Models produce it only through the `report_finding`
tool, whose parameter schema is this type minus the orchestrator-owned
fields ([D-4](README.md#key-decisions)).

| Field | Set by | Notes |
|---|---|---|
| `id` | orchestrator | Unique within a run |
| `fingerprint` | orchestrator | [A-4](#a-4--fingerprint) |
| `source` | orchestrator | `reviewer:<name>` |
| `tag` | producer | `important` · `nit` · `pre-existing` — the review process's taxonomy. Posted as the first word of the comment |
| `category` | producer | For clustering and metrics only, never shown: `correctness`, `security`, `concurrency`, `data-loss`, `compatibility`, `performance`, `error-handling`, `tests`, `hygiene`, `docs` |
| `locations[]` | producer | `{path, startLine, endLine}`. First is the anchor; the rest are other instances of the same problem |
| `title`, `body` | producer | Body states the concrete failure: what breaks, for whom, when, and how often the trigger has to happen |
| `evidence[]` | producer | `{root, path, startLine, endLine, quote}` where `root` is `head`, `base` or `modcache`. Quotes are verified mechanically ([S-5](03-review-pipeline.md#s-5--verify)) |
| `traced`, `assumed` | producer | What was read versus assumed |
| `suggestion` | producer, optional | Replacement text for a GitHub suggestion block |
| `ruleRefs[]` | producer, optional | The `REVIEW.md` / `AGENTS.md` / guideline heading the finding applies. Feeds pruning ([L-6](04-learning-loop.md#l-6--pruning)) |
| `proposedIssue` | producer, pre-existing only | One-line `tech-debt` issue title, or the URL of an existing issue |
| `mechanizable` | producer | `{possible: boolean, sketch?: string}` — could lint or a script have caught this? Feeds [L-5](04-learning-loop.md#l-5--promotion-to-a-deterministic-check) |
| `confidence` | producer | Recorded for analysis only. **Never used as a gate** |
| `status` | orchestrator | `proposed` → `verified` · `unverified` · `refuted` · `duplicate` · `over-limit` → `published` |
| `statusReason` | orchestrator | Required for every non-published finding |

Two sibling output types, also tool-only:

- **Question** — `{locations[], body}`, for stated trade-offs or
  environment-dependent impact. Posted in the summary.
- **Needs-human note** — `{what, locations[], explainedInDescription}`.
  Posted as the summary's final line, never as a finding.

## A-4 — Fingerprint

A stable identity for "the same issue" across pushes, line shifts, and runs.
`sha256(path, category, normalized anchor)` where the anchor is the flagged
code with whitespace collapsed. Used to avoid re-posting, to join findings
to outcomes, and to match thread replies. The exact recipe is tunable:
record a `fingerprintVersion` in every record.

## A-5 — Knowledge sources

**The bot ships no review guidance.** What matters in a repository is
written by its owners, in that repository, in the files the review process
already defines ([D-6](README.md#key-decisions)). All are read from the base
branch ([D-7](README.md#key-decisions)).

| File | Owner | Bot reads it for |
|---|---|---|
| `AGENTS.md` (root) | repo owners | What the project is, conventions, how to verify, what counts as user-facing. Also checked for lines the PR makes stale |
| `REVIEW.md` (root, optionally per area) | code owners | What failure looks like, focus, don't-flag, needs-human, skip paths, evidence rules, limits, summary format |
| `.review/<family>-guidelines.md` | vendored from the source-of-truth repo | Rules shared by a family of repositories |
| `.review/review-bot.yaml` (optional) | repo owners | Bot settings only: role→model map, limits, authorization label, CI wait. Overrides workflow inputs, but can only choose among models the operator's pi configuration provides, and can never add providers, endpoints or packages ([F-7](01-foundation-pi.md#f-7--configuration-follows-pi)) |

- **Per-area `REVIEW.md`:** a `REVIEW.md` in a subdirectory applies to
  changes under it, in addition to the root file.
- **Sections the bot parses mechanically:** "Skip these paths" (globs) and
  "Limits" (nit cap). Everything else is given to the reviewer verbatim.
  This makes the review-process template's headings a contract; a missing
  heading falls back to "no skip paths" / "no cap".
- **No `REVIEW.md` → no review.** The repository is not onboarded (RP
  Phase 2 and 3 come before automated review). The check run completes as
  *skipped* with that reason.
- **What the bot does ship:** the review *method* (how to trace, verify and
  report — [S-4](03-review-pipeline.md#s-4--review)) and the output schemas.
  The method is repository- and language-neutral. If the method ever needs
  to say something about a specific stack, that text belongs in the shared
  guidelines instead.
- The run record stores the base SHA the knowledge was read from, so any
  run can be reproduced.

## A-6 — Run record

One JSON document per run ([P-5](README.md#principles)), wrapped in the
review process's shared report envelope (`tool`, `toolVersion`, `repo`,
`generatedAt`, `metrics`, `findings`).

- Identity: repo, PR number, base SHA, head SHA, run ID, timestamps,
  trigger, scope (full / incremental), round.
- Waiting: when the head SHA was first seen, when required CI completed
  ([C-9](06-ci-and-security.md#c-9--waiting-for-ci)), when the review job
  started. Input to the queue-time metrics ([O-1](10-metrics.md#o-1--what-is-measured)).
- Wall time per stage, not only per model step.
- Versions: bot version, pi version, method-skill hash, knowledge base SHA,
  `fingerprintVersion`, role→model mapping as configured **and** the model
  ID the provider actually served for each step; every pi package loaded
  from the operator configuration, with its resolved version, and a hash of
  `models.json` ([F-7](01-foundation-pi.md#f-7--configuration-follows-pi)).
- Inputs: file list with exclusions and reasons; which knowledge files were
  loaded.
- Findings, questions and needs-human notes: **all** of them, with final
  `status` and `statusReason`.
- Per-step usage: tokens in/out/cached, cost, wall time, outcome
  (`ok` · `timeout` · `error` · `truncated` · `cancelled`); whether the cost
  is the provider's billed amount or a catalog estimate; and tool calls that
  were rejected (schema violations, guard blocks).
- **Aborted model calls report zero usage**, so a timed-out step
  under-reports its cost. Such steps are marked `usageComplete: false`
  and counted in the run summary; the cost is not estimated. Because the
  flag is per step, totals can be given with and without such steps.
- Served model per step is `responseModel ?? model`: pi sets `responseModel`
  only when the provider served a different ID from the one requested.
- Result: what was published (comment IDs), check-run conclusion.

The record does not hold file contents: repo + SHAs are enough to re-fetch
them for replay.

## A-7 — Store

**The review job never writes to a repository or to storage.** It runs on
`pull_request_target` for fork PRs and holds `pull-requests` and `checks`
write permissions, plus `contents: read` and `issues: read` on private
repositories for the reviewer's history and issue tools
([C-4](06-ci-and-security.md#c-4--fork-pull-requests-and-authorization)).
None of these lets it write to a repository. Its run record leaves the job in exactly one way: as
a **workflow artifact**, which needs no extra permission.

Durable storage is written by the **harvest job**, which runs on a schedule
from the default branch and never touches PR content:

1. It downloads run-record artifacts produced since its last run
   (`actions: read`; default artifact retention is 90 days, far longer than
   the harvest interval).
2. It reads outcomes from GitHub.
3. It appends both to the store.

Store implementations behind one interface:

| Implementation | When |
|---|---|
| **Reports repository per organization** (default) — one JSON file per record, committed by the harvest job | Matches the review process's cheapest reporting option and its rule that nothing is shared across organizations. No infrastructure |
| Object storage bucket | Organizations that prefer it, or when volume outgrows a git repository |

If the store is unavailable, nothing on a PR is affected, and the findings
themselves are still recoverable from GitHub comments. What would be lost is
only the dropped findings and cost data for runs older than artifact
retention.

## A-8 — Repository layout (this repo)

```
src/
  core/  agent/  platform/  store/  pipeline/  learn/  eval/  cli/
pi-review/           # the pi package: package.json with "pi" manifest
  extension/  skills/  prompts/
action/              # GitHub Action wrapper (action.yml)
workflows/           # reference workflow files for the sync tool to vendor
evals/               # corpus manifests and labels (not the code under review)
docs/plan/
```

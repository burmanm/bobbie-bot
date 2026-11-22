# Review bot — design plan

An autonomous pull-request review agent built as a package on top of the
[pi](https://pi.dev) agent harness. It runs without user input in CI
(GitHub Actions first) and improves over time by learning from the outcomes of
its own reviews.

Status: **planning only, nothing implemented.** Dated 2026-11-15.

The bot is one layer of a larger review process defined in the separate
`review-process` repository. That process sets the bot's output contract;
see [09-process-integration.md](09-process-integration.md). References to it
appear as *RP §n*.

## How to read this

Each file is self-contained enough to hand to an implementer. Sections carry
stable IDs (`P-1`, `D-3`, `S-4` …) so they can be referenced from issues and
PRs.

| File | Contents | IDs |
|---|---|---|
| [01-foundation-pi.md](01-foundation-pi.md) | What we build on, how we integrate with pi, the Pi Durable decision, facts still to verify | `F-*` |
| [02-architecture.md](02-architecture.md) | Components, module boundaries, data contracts, repository layout | `A-*` |
| [03-review-pipeline.md](03-review-pipeline.md) | The review run, stage by stage | `S-*` |
| [04-learning-loop.md](04-learning-loop.md) | Feedback signals, knowledge ladder, promotion to deterministic checks | `L-*` |
| [05-evaluation.md](05-evaluation.md) | Replay harness, metrics, how changes (including model changes) are accepted | `E-*` |
| [06-ci-and-security.md](06-ci-and-security.md) | GitHub Actions operation, trust model, failure behaviour | `C-*` |
| [07-roadmap.md](07-roadmap.md) | Phases with exit criteria, deferred work, open questions | `R-*`, `Q-*` |
| [08-research-notes.md](08-research-notes.md) | Digest of the sources this plan draws on, with what is unverified | — |
| [09-process-integration.md](09-process-integration.md) | What lives in the bot versus the review process; the contract the bot must honour | `I-*` |
| [10-metrics.md](10-metrics.md) | Production metrics (cost, findings, rounds, human comments, missed findings, timings) and how they are collected | `O-*` |
| [r1a-proposal.md](r1a-proposal.md) | The accepted R-1a proposal, with the evidence behind F-7 and D-19 | — |
| [spike-r0-findings.md](spike-r0-findings.md) | Verified answers to the pi questions, with evidence; proposed `AgentStep` interface | — |

## Principles

**P-1 — Code for what is certain, model for judgment.** Anything that can be
decided without a model (file filtering, lint, schema validation, quote
grounding, dedupe, posting) is plain code. The model is only asked questions
that need judgment, and it answers in typed form.

**P-2 — The model's second job is to find work for P-1.** Every finding is
tagged with whether it could have been caught mechanically. Recurring
mechanizable findings are promoted to deterministic checks, after which the
model stops reporting that class. See [L-5](04-learning-loop.md#l-5--promotion-to-a-deterministic-check).

**P-3 — Code controls flow.** The orchestrator is ordinary TypeScript. Models
never decide which stage runs next and, with the default tools, never post to
GitHub or see write credentials. Modules the maintainers configure are trusted
code and are not held to this ([D-19](#key-decisions)).

**P-4 — Model-agnostic.** No stage depends on a specific model. Stages name a
*role* (`reviewer`, `verifier`, optionally `learner`); configuration maps roles
to models, and that mapping is expected to change often. A model change is
checked by replaying past PRs
([E-5](05-evaluation.md#e-5--acceptance-procedure)). The bot never needs a
model stronger than the one it reviews with: judging, interviewing and
teaching happen outside it
([E-0](05-evaluation.md#e-0--what-is-in-the-bot-and-what-is-not)).

**P-5 — Every run leaves a replayable record.** Inputs, knowledge version,
all findings (including dropped ones and why), cost, and model IDs. Without
this there is nothing to learn from and nothing to evaluate against.

**P-6 — Learning is gated and reviewable.** The bot proposes changes to its
own knowledge as pull requests with provenance. A human merges them. The bot
never silently changes its own behaviour.

**P-7 — Precision before volume.** A wrong or trivial comment costs more
trust than a missed nit gains — more so when the author is an agent that
will act on every comment. Drop a finding only when code proves it wrong;
otherwise keep it but label it. Style belongs to linters; nits are capped by
the repository's `REVIEW.md`.

**P-8 — Comment, never approve.** The bot posts a comment-only review and
never approves; a bot approval never counts as a human one. Whether open
findings block a merge is decided by the review process (conversation
resolution and the review-state workflow), not by the bot.

**P-10 — The repository owns what matters.** The bot ships a review
*method* and no review *guidance*. What to focus on, what not to flag, and
what to skip come from the repository's own `AGENTS.md`, `REVIEW.md` and
vendored guidelines. A lesson learned is written back to those files or to
CI, never to a bot-private store.

**P-9 — Measure first, optimize later.** Cost and latency are recorded from
the first run but not optimized until real usage shows where the money goes.
Safety limits (timeouts, spend caps) are not optimization and are in from the
start.

## Key decisions

| ID | Decision | Detail |
|---|---|---|
| D-1 | Build on `@earendil-works/pi-coding-agent` (MIT), shipped as a pi package | [F-1](01-foundation-pi.md#f-1--what-pi-is) |
| D-2 | Each model step is a pi SDK session created by our own orchestrator (confirmed by the R-0 spike, pi pinned to 1.5.2). The orchestrator is started as a pi command, so the whole bot is a pi module. Jobs without a model stay plain CLI | [F-3](01-foundation-pi.md#f-3--integration-shape) |
| D-3 | Do **not** build on Pi Durable now; keep stage boundaries so it can be adopted later | [F-4](01-foundation-pi.md#f-4--pi-durable-decision) |
| D-4 | Findings are emitted through a typed tool call, never parsed from prose. Guaranteed unless an operator's module replaces the output tools | [A-3](02-architecture.md#a-3--finding) |
| D-5 | Review state lives in GitHub (hidden markers in the bot's own comments, which its check runs record); the review job itself needs no database | [S-7](03-review-pipeline.md#s-7--publish) |
| D-6 | Knowledge is the repository's own `AGENTS.md`, `REVIEW.md` and vendored guidelines; no built-in guidance, no bot-private format | [A-5](02-architecture.md#a-5--knowledge-sources) |
| D-7 | Knowledge is always read from the base branch, never from the PR head | [C-3](06-ci-and-security.md#c-3--trust-model) |
| D-8 | Start with one reviewer plus a verifier; add reviewer fan-out only when the eval harness shows it pays | [S-4](03-review-pipeline.md#s-4--review) |
| D-9 | Learning runs offline on a schedule, not inside the review job | [L-1](04-learning-loop.md#l-1--shape-of-the-loop) |
| D-10 | The approval flow (state labels, human review requests, needs-human detector) stays in review-process; the bot honours its contract | [I-1](09-process-integration.md#i-1--what-lives-where) |
| D-11 | Deterministic checks live in the repository's CI. The bot proposes them and does not run or host them | [L-5](04-learning-loop.md#l-5--promotion-to-a-deterministic-check) |
| D-12 | The job that holds secrets never checks out or executes PR code; fork PRs are the main path | [C-4](06-ci-and-security.md#c-4--fork-pull-requests-and-authorization) |
| D-13 | The review job writes only a workflow artifact; durable records are written by the scheduled harvest job | [A-7](02-architecture.md#a-7--store) |
| D-14 | Every run completes its `ai-review/<name>` check run, whatever happens | [S-9](03-review-pipeline.md#s-9--failure-behaviour) |
| D-15 | Every pi session is created with explicit isolation in a working directory outside the PR's tree, and the tool guard confines the read tools' paths; a regression test guards both, with modules loaded | [C-3a](06-ci-and-security.md#c-3a--pi-session-isolation) |
| D-16 | Optionally, no review until the repository's CI has passed on the head SHA; the check waits as *queued* | [C-9](06-ci-and-security.md#c-9--waiting-for-ci) |
| D-17 | Metrics are pulled by the harvest job from run records and the GitHub API, stored with the run records, and optionally exported from there; the review job pushes nothing | [O-2](10-metrics.md#o-2--how-the-numbers-are-collected) |
| D-18 | Configuration follows pi: any pi module can be loaded; providers, models, packages and the bot's own settings (`reviewBot` in `settings.json`) live in an operator pi agent directory | [F-7](01-foundation-pi.md#f-7--configuration-follows-pi) |
| D-19 | The trust line is a merge: nothing from a PR is executed or becomes configuration without one. What maintainers merged, modules included, is trusted and shares the process with the job's credentials | [C-3](06-ci-and-security.md#c-3--trust-model) |

## Glossary

- **Run** — one execution of the review pipeline for one PR head SHA.
- **Finding** — one candidate issue, tagged Important, Nit or Pre-existing.
- **Check** — a deterministic detector (lint rule, script) in the repository's CI.
- **Outcome** — what happened to a published finding: `fixed`, `wrong`, `intentional`, `not-worth-it`.
- **Knowledge** — a repository's `AGENTS.md`, `REVIEW.md` and vendored shared guidelines.
- **Agent directory** — the operator's pi configuration directory: `settings.json`,
  `models.json`, and what they list.
- **Module** — a pi package or extension listed in the agent directory.
- **Method** — the bot's own instructions on how to review; contains nothing repository-specific.
- **Role** — a named model slot in configuration.
- **RP** — the `review-process` repository.

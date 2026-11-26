# 09 — Integration with the review process

The review bot is **layer 3** ("automated code review") of the layered model
defined in the separate `review-process` repository
(`github.com/burmanm/review-process`; `00-plan.md` §3). That repository owns
the process; this one owns one participant in it. Where the two disagree,
`review-process` wins and this plan is corrected.

References below of the form *RP §n* point at `review-process/00-plan.md`;
*RP T3* etc. are its open-question IDs.

## I-1 — What lives where

| Concern | Lives in | Why |
|---|---|---|
| Review-state labels, `review/bots-done` status, round cap, requesting human reviewers (RP §4.2) | `review-process` (vendored workflow) | Deterministic, no model, must work with any reviewer vendor and with the bot switched off, needs different permissions (labels, statuses, reviewer requests) |
| `needs-human` detector (RP T17) | `review-process` / repo CI | Mechanical diff scan |
| "Reviews before your own PRs" gate, stale-PR nudge | `review-process` | Not about review content |
| Deterministic checks (lint, generated files, changelog, docs note) | The repository's own CI and local check command (RP §3.1) | They must also run locally and before review |
| Risk tiers, CODEOWNERS, approvals | `review-process` + GitHub settings | Human layer |
| Process metrics (`review-metrics`) | `review-process` | Already exists, in Go. The bot's harvest job also computes the shared timings next to its own numbers, using `review-metrics`'s definitions ([O-3](10-metrics.md#o-3--relation-to-review-metrics)) |
| Waiting for CI before reviewing | **review bot** gate job ([C-9](06-ci-and-security.md#c-9--waiting-for-ci)) | Saves model cost on red builds; no state labels involved |
| Reading the change, producing verified findings, posting one review | **review bot** | Judgement |
| Recording finding outcomes; proposing changes to `REVIEW.md`, lint config or CI checks | **review bot** (harvest and learn jobs) | Needs the bot's run records and fingerprints |
| Local pre-PR review (RP layer 1, step 3.3) | **review bot** pi package, `/review-bot` | Same pipeline on a working tree |

**Recommendation on the approval flow (tests → LLM review → human review):
keep it outside the bot.** It is a state machine over GitHub events with no
judgement in it; by [P-1](README.md#principles) that is plain code, and RP
§4.2 already requires it to be reviewer-agnostic ("one check per reviewer …
works with any vendor, and several agents per PR"). Putting it inside a
pi-based agent would tie the process to one reviewer and give the reviewer's
job permissions it should not hold. The bot's obligation is to honour the
contract in I-2.

## I-2 — Contract the bot must honour

| # | Obligation | Source |
|---|---|---|
| 1 | Report a check run named `ai-review/<name>` on the PR **head SHA**, and **always complete it** — also when the review is skipped, not authorized, or fails internally. An unfinished check leaves the PR stuck in `review/bots` | RP §4.2, templates §12 |
| 2 | Post as a Bot-type identity (App or the Actions token). The state workflow counts unresolved threads whose first comment is by a Bot and contains the word `Important` | templates §12 |
| 3 | Tag every finding **Important**, **Nit** or **Pre-existing**. The tag is the first word of the comment | RP §3 layer 3, templates §3 |
| 4 | Pre-existing findings go in the summary only, each with a one-line proposed `tech-debt` issue, after checking whether an issue already exists | RP decision 2026-10-21 |
| 5 | Changes that always need a human (new `//nolint`, changed or removed assertions in existing tests) are a `Needs human:` line, **not findings**. The bot puts these lines in a warning block right under the count line (changed from "at the end of the summary" after the pilot's first runs, where the line was easy to miss). A finding is raised only when the PR description does not explain the change | RP decision 2026-10-21 |
| 6 | Trade-offs stated in the PR description are not flagged. If one leads to a failure listed in `REVIEW.md`, ask a question instead of reporting a finding | RP decision 2026-10-21 |
| 7 | Never flag what lint or a CI check enforces; never flag the changelog category | templates §3, RP decision 2026-10-21 |
| 8 | Never approve. Review event is `COMMENT`. Blocking comes from the branch rule "require conversation resolution" and the state workflow, not from the bot | RP §3 layer 5 |
| 9 | Do not repeat findings already posted on the PR — by this bot, another bot, or a human. Re-review covers only the new commits and re-checks earlier findings | RP §6 Loop B |
| 10 | When the same problem appears in several places, report it once and list every location | templates §3 |
| 11 | Summary starts with a count ("N important, M nits, K pre-existing"), says plainly when there is nothing to fix, lists what was checked and what could not be run, and reminds how to resolve (`[wrong]` / `[intentional]` / `[not-worth-it]`) | templates §3, §5 |
| 12 | Evidence: file and line, concrete failure and how often the trigger occurs; functions named are traced; claims about library behaviour cite the library source at the pinned version; sub-step conclusions are verified before becoming findings | templates §3, RP decision 2026-11-03 |
| 13 | Read `AGENTS.md`, `REVIEW.md` and the vendored shared guidelines from the repository. Flag a change that makes a line in `AGENTS.md` out of date | RP §5 |
| 14 | Agents never push to a PR in `review/human`. The bot never pushes to PR branches at all | RP §4.2 |
| 16 | Resolve its own thread when it verifies the finding as fixed, so the PR can leave `review/author` without the author resolving by hand. Resolve nothing else | Decided 2026-11-15 ([Q-9](07-roadmap.md#open-questions)) |
| 15 | Scheduled jobs (harvest, learn) follow the maintenance-agent rules: report-only start, review budget, `agent/<name>` label, no duplicates, kill switch variable, named owner, pushes only to `agent/*` branches, shared JSON report envelope | `04-maintenance-agents.md` §1, §6 |

## I-3 — Consequences for this plan

| Earlier plan | Now |
|---|---|
| Built-in default `REVIEW.md`; bot-specific `.review/rules/`, `learnings/`, `suppressions.yaml`, `checks/` | No built-in review guidance. Knowledge is the repository's `AGENTS.md`, `REVIEW.md` and vendored guidelines ([A-5](02-architecture.md#a-5--knowledge-sources)) |
| Bot runs deterministic checks itself | Checks belong to repo CI. The bot proposes them; it does not host them ([L-5](04-learning-loop.md#l-5--promotion-to-a-deterministic-check)) |
| Severity `critical / major / minor`, no nits | `Important / Nit / Pre-existing`, nit cap from `REVIEW.md` ([A-3](02-architecture.md#a-3--finding)) |
| Outcomes inferred from reactions and judged replies | Reply prefixes are the primary signal, parsed without a model ([L-2](04-learning-loop.md#l-2--signals)) |
| Fork PRs out of scope; head checked out in the privileged job | Fork PRs are the main path. Two-job design: the job holding secrets never checks out or executes PR code ([C-4](06-ci-and-security.md#c-4--fork-pull-requests-and-authorization)) |
| Job "never fails checks", exits quietly | Always completes its `ai-review/<name>` check run ([S-9](03-review-pipeline.md#s-9--failure-behaviour)) |
| Eval accepted if metrics do not regress beyond spread | RP Loop C rule: must still catch every known-bad PR the previous version caught, and raise no more false alarms on known-clean PRs ([E-5](05-evaluation.md#e-5--acceptance-procedure)) |
| Learn job is its own design | It is a maintenance agent, sibling of RP's "agent-context tuner" (2.2), sharing the harvested data ([L-1](04-learning-loop.md#l-1--shape-of-the-loop)) |

## I-4 — Inputs available from review-process

- `pilot/cass-operator/REVIEW.md`, `AGENTS.md`, `shared/go-operator-guidelines.md`
  — real knowledge files to develop and test against.
- `Claude outputs/*.json` — 16 dry-run reviews of cass-operator and
  k8ssandra-operator PRs, already in GitHub review payload shape
  (`review.{commit_id,event,body,comments[]}` + `thread_replies[]`). They are
  the reference for output format and tone, and candidate eval cases once an
  owner confirms which findings were right.
- The first eval cases from the cass-operator reconcile audit (RP M5).
- `tools/review-metrics` — process metrics; the bot does not duplicate them.

## I-5 — Gaps this exposes in review-process (to raise there)

- **RP T3** asks for small probes and `go test` during review. A job that
  holds secrets cannot execute code next to PR code (RP T16 says the same).
  Until a sandbox exists the bot cites library source from the module cache
  and reports what it could not run ("Not run: …"), as the dry-run reviews
  already do.
- The state workflow identifies Important threads by a regex on the first
  comment. That is a fragile contract; a hidden marker would be sturdier.
- Outside-contributor PRs that are not authorized for automatic review still
  need a completed `ai-review/<name>` check, or they never leave
  `review/bots`. The bot completes it as *skipped* (I-2 #1).
- **CI failure and the state workflow.** With
  [C-9](06-ci-and-security.md#c-9--waiting-for-ci) the bot's check can be
  *skipped* because CI failed. The state workflow should not read that as
  "bots done" and request people; it should hold the PR in `review/author`
  until CI passes. That ordering (tests → bots → humans) belongs to the
  state workflow.
- **The human-approval request event.** Metrics need one well-defined
  moment when a PR is handed to people
  ([O-1](10-metrics.md#o-1--what-is-measured)). The bot assumes the first
  `review/human` label; review-process should state it, and
  `review-metrics` and the harvest job should share the definition of every
  timing ([O-3](10-metrics.md#o-3--relation-to-review-metrics)).

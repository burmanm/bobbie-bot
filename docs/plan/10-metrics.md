# 10 — Operational metrics

What the bot costs, how much it says, how much of it lands, and how it
changes the time a PR takes. [E-3](05-evaluation.md#e-3--metrics) defines
the quality numbers for replay and the outcome shares; this file defines
the full set of production metrics, where each number comes from, and how
it leaves GitHub.

Measured from the first live run ([P-9](README.md#principles)), not
optimized until the numbers show where to look.

## O-1 — What is measured

Three levels. Each metric names its source; "record" is the run record
([A-6](02-architecture.md#a-6--run-record)), "harvest" is the harvest job
reading GitHub after the fact.

### Per run

| Metric | Source |
|---|---|
| Cost: billed or estimated, per step and total; `usageComplete` count | record |
| Tokens in / out / cached per step | record |
| Wall time per stage and total | record |
| Queue time: head push → review job start, split into waiting for CI ([C-9](06-ci-and-security.md#c-9--waiting-for-ci)) and waiting for a runner | record (CI wait), Actions jobs API (runner wait) |
| Findings proposed, by tag | record |
| Findings rejected inside the bot, by reason: grounding failed, refuted by the verifier, duplicate, over the nit cap | record (`status`, `statusReason`) |
| Findings published, by tag; questions; needs-human notes | record |
| Round number, scope (full / incremental), served models, skip reason | record |

### Per PR (computed when the PR closes, and refreshed while open)

| Metric | Definition | Source |
|---|---|---|
| Bot runs | Runs that published, and runs in total including skipped and failed | records |
| Rounds | Bot reviews that published, i.e. how often the author and the bot went back and forth | records |
| Cost | Sum over all runs of the PR | records |
| Bot comments | Inline findings published, by tag; thread replies | records |
| Important findings | Published Important findings, and how many ended `fixed` | records + harvest |
| Rejected by people | Published findings answered `[wrong]`, `[intentional]`, `[not-worth-it]` ([L-2](04-learning-loop.md#l-2--signals)), each counted separately | harvest |
| Unlabelled | Published findings resolved with no prefix and no change | harvest |
| Human comments | Review threads started by people (not by any bot), and how many of those led to a code change | harvest |
| Missed findings | Human threads that led to a change where the bot had no finding at that location ([L-2](04-learning-loop.md#l-2--signals) "missed issue"); later, escaped bugs from `Follow-up to: #N` | harvest |

"Rejected" therefore has two meanings and they are never added together:
*rejected inside the bot* (per run, before anything is posted) measures
the verifier and grounding; *rejected by people* (per PR) measures noise
that got through.

### Per PR, timings

Built from the PR's timeline. The **human-approval request** is the moment
the review process hands the PR to people: by default the first time the
`review/human` label is applied, falling back to the first review request
to a person when the label is not used. The event that defines it is
configurable because the review process owns it
([Q-18](07-roadmap.md#open)).

| Metric | From → to |
|---|---|
| Time to first bot review | PR ready for review (opened, or `ready_for_review` for drafts) → first published bot review |
| Bot phase | First bot review → human-approval request |
| Time to human request | PR ready for review → human-approval request |
| Author turnaround per round | Bot review → the author's next push |
| Human review | Human-approval request → merge. Also: → first human review, and the number of times the PR went back to the author after it |
| Total | PR ready for review → merge or close |

A PR that is closed without merging keeps its timings up to the close and
is reported separately. Time a PR spends as draft is excluded.

### Aggregates

Per repository and per week: medians and p90 of the above, outcome shares
([E-3](05-evaluation.md#e-3--metrics)), cost per PR and per published
Important finding, share of PRs where the bot found nothing to fix, missed
findings per PR. Broken down by served model and by method-skill hash, so a
model change or a method change shows up as a step in the series.

## O-2 — How the numbers are collected

Four ways were considered.

| Option | For | Against |
|---|---|---|
| **A. Pull, in the harvest job** — read run-record artifacts and the PR timeline from the GitHub API, compute, store | No new credentials or infrastructure; deterministic; can be recomputed for history whenever a definition changes or a metric is added; sees outcomes and human timings, which only exist after the review | Artifacts expire (90 days by default); API rate limits on large backfills |
| B. Push from the review job to a metrics endpoint (OTLP, Prometheus push gateway, a vendor) | Real-time | Puts a second credential and an egress path into the job that already holds the model key and runs on fork PRs ([C-3](06-ci-and-security.md#c-3--trust-model)), against [D-13](README.md#key-decisions). Sees only its own run: no outcomes, no human timings |
| C. Job summary and check-run output | Already exists ([C-8](06-ci-and-security.md#c-8--observability)) | Human-readable only; nothing to aggregate |
| D. GitHub Actions API alone (workflow and job durations) | Gives runner queue time | Knows nothing about findings or the PR's process timeline |

**Decision ([D-17](README.md#key-decisions)): A, with D as one of its
inputs and an optional export at the end.**

1. **Review job** — unchanged. Everything per run goes in the run record,
   which leaves the job only as a workflow artifact
   ([A-7](02-architecture.md#a-7--store)). New record fields: CI wait and
   queue timestamps ([A-6](02-architecture.md#a-6--run-record)).
2. **Harvest job** (scheduled, and on PR close) collects:
   - run-record artifacts since its last run;
   - for each PR touched: timeline events (labels, review requests,
     `ready_for_review`, merge, close), reviews, review threads and their
     replies, and pushes;
   - from the Actions jobs API: queue and run times of the review jobs.
   It computes the per-run and per-PR metrics of O-1 and writes one
   **metrics record per PR** to the store next to the run records and
   outcomes. A per-PR record is rewritten each time the PR changes, until
   it is closed.
3. **Reports.** Aggregates are computed from the store, not kept as
   separate state. The weekly report (the learn job's report issue,
   [L-4](04-learning-loop.md#l-4--proposing-reviewmd-changes)) carries the
   headline table. For the default store, a reports repository, the
   records are plain JSON files that any notebook or dashboard can read.
4. **Optional export.** A `MetricsSink` interface, called by the harvest
   job only, after the store write: OpenTelemetry (OTLP) metrics first,
   since most backends accept it. The sink's credential lives only in the
   harvest workflow, which runs on the default branch and never touches PR
   content. The store remains the source of truth; a failed export is
   retried on the next harvest, and the metrics can be rebuilt from the
   store at any time.

Retention: run records older than artifact retention survive only in the
store, so a harvest gap longer than 90 days loses per-run detail (not the
GitHub-side timeline, which can be re-read). The harvest interval is
therefore daily.

## O-3 — Relation to `review-metrics`

The review process already has a process-metrics tool, `review-metrics`
([I-4](09-process-integration.md#i-4--inputs-available-from-review-process)).
Pure process timings (time to human request, human review time) are its
territory, and two different definitions of "review wait" would be worse
than one. The harvest job computes them anyway, because the bot-side
numbers (bot phase, rounds, cost per PR) are only meaningful next to them,
but:

- the definitions of the shared timings follow `review-metrics` and are
  changed there first ([I-5](09-process-integration.md#i-5--gaps-this-exposes-in-review-process-to-raise-there));
- the per-PR metrics record uses the review process's shared report
  envelope, so `review-metrics` can read it instead of recomputing.

## O-4 — What these numbers are not

- **Not a quality score.** Fewer findings is not better and more is not
  worse; the `fixed` share and missed findings are the quality signals,
  and the eval set ([E-5](05-evaluation.md#e-5--acceptance-procedure)) is
  what accepts a change.
- **Not a gate.** No metric blocks a PR or changes the bot's behaviour
  automatically. Cost limits are safety limits, configured separately.
- **Not per person.** Timings are reported per repository and PR, never
  ranked by author or reviewer.

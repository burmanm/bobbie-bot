# 05 — Evaluation

Models will change, prompts will change, `REVIEW.md` will change. The only
stable thing is the measurement. This harness is what makes
[P-4](README.md#principles) (model-agnostic) practical, it is a prerequisite
for the learning loop's validation step, and it is the implementation of the
review process's Loop C (RP §6: "any change to the reviewer's prompts,
`REVIEW.md` defaults, or tooling is run against this set before rollout").
It answers RP M6 — the eval set runs as a command and as a workflow.

## E-0 — What is in the bot and what is not

| Part | Where | Why |
|---|---|---|
| **Replay**: run the real pipeline on a list of historical PRs and capture the would-be reviews | Bot | Only the bot can run its own pipeline. This does not come for free from live PR review: production outcomes describe the configuration that ran, after the fact; they cannot say whether a *proposed* change loses a bug that used to be caught |
| **Mechanical diff** of two replays: findings that appeared, disappeared, or moved, and which expected locations were hit | Bot | Deterministic; no model ([P-1](README.md#principles)) |
| **Judging**: is this finding correct, does it really match the expected issue | **Outside the bot** | Needs the strongest available judgement — a person, typically working with a strong model interactively. Which model that is changes often and may not be reachable from CI at all |
| **Accept / reject decision** | **Outside the bot** (review process, Loop C) | A policy of the people rolling out the change, recorded in the PR |
| **Interviewing a review**: a person and a strong model examining what the reviewer did and why | **Outside the bot** | See [L-7](04-learning-loop.md#l-7--teaching-and-interviewing-outside-the-bot). The bot's part is to leave records good enough to interview |

The bot therefore has **no `judge` role** and never needs a model stronger
than the one it reviews with. A deployment that reviews with a cheap model
and reserves a strong model for interactive use is fully supported.

## E-1 — Two kinds of measurement

| | Offline (replay) | Online (production) |
|---|---|---|
| Question | Is change X safe to roll out? | Is the bot useful to people? |
| Data | Eval set of historical PRs | Outcomes harvested from live PRs (Loop A) |
| When | Before accepting any change | Continuously |
| Strength | Controlled, repeatable | Real |
| Weakness | Ground truth is approximate | Slow, confounded |

## E-2 — Corpus

Per repository, as RP Loop C defines it. Manifests and labels live in this
repository's `evals/` for public repositories, and in the organization's
reports repository for private ones.

**Known-bad PRs** — a merged PR that introduced a problem, with the bug and
its location confirmed by someone who knows the code (RP 6.2: non-owners
dig, an owner confirms). Sources, most reliable first:

1. PRs named in a later PR's `Follow-up to: #N` field (RP M2), and
   backfilled `[BUGFIX]` changelog entries that name the introducing PR.
2. Incidents and reverts traced to a merged change.
3. Bugs found by human review: a review comment followed by a change to the
   flagged lines. The case uses the head SHA *at the time the comment was
   made*, not the merged head.
4. Audits of existing code (the first four cases come from the
   cass-operator reconcile audit, RP M5).
5. Bot findings from production whose outcome was `fixed`.

**Known-clean PRs** — merged PRs with thorough human review, no later
follow-up, used to measure false alarms.

**Seed material:** the dry-run reviews in `review-process/Claude outputs/`
cover 16 cass-operator and k8ssandra-operator PRs. Once an owner marks which
of their findings were right, they become cases with expected findings.

**Case** = repo, PR number, base SHA, head SHA to review, expected issues
(location, tag, short description), and the knowledge SHA to use.

**Splits:** `tune` (may be looked at while iterating) and `held-out` (used
only for the accept/reject decision), split by time so held-out is newer.
While the set is small — it will be for months — every case is in both, and
that limitation is stated in every report.

## E-3 — Metrics

Offline, four headline numbers (from agentrun's code-review case study):

| Metric | Definition | Computed by |
|---|---|---|
| **Known-bad hit** | Known-bad cases where a published finding's location overlaps the expected issue's location ÷ known-bad cases | Bot, mechanically. A *hit* is a candidate match, not a verdict |
| **Important hit** | Same, for expected issues tagged Important | Bot |
| **Findings on known-clean** | Published Important findings on known-clean cases | Bot. Each is a candidate false alarm |
| **Cost** | Mean and p95 spend and wall time per review | Bot |

Rules:

- A run that times out or errors **counts as nothing hit**, not as missing
  data.
- Model output varies, so each case is replayed several times (default 3,
  configurable). The report shows **every run**, plus how many runs hit each
  expected issue ("2 of 3"). The bot does not turn that into a pass/fail;
  how many hits count as "caught" is the evaluator's call
  ([E-5](#e-5--acceptance-procedure)).
- Whether a hit really is the expected bug, and whether an unexpected
  finding is right or wrong, is judged outside the bot
  ([E-0](#e-0--what-is-in-the-bot-and-what-is-not)). Verdicts can be written
  back into the case file as labels, so the next replay's mechanical report
  is more accurate.

Online, from harvest ([L-2](04-learning-loop.md#l-2--signals)) — these are
RP §2's "automated finding outcomes" and Phase 5 exit criteria:

- Outcome shares: `fixed`, `wrong`, `intentional`, `not-worth-it`,
  `unlabelled`. The `fixed` share is the primary number.
- Rounds-to-pass per PR.
- Findings per review by tag; share of reviews with nothing to fix.
- Missed issues (human-found) and escaped bugs (`Follow-up to:`).
- Per `REVIEW.md` line: citations and outcome mix
  ([L-6](04-learning-loop.md#l-6--pruning)).

Process-level metrics (review wait, approvals, follow-up fix rate) stay in
`review-metrics`; the bot does not compute them.

## E-4 — Replay harness

`review-bot eval --corpus <manifest> [--roles …] [--knowledge <ref>] [--variant <name>]`

- Runs the real pipeline S-1…S-6 with a `Platform` implementation that reads
  the historical PR and **captures** the would-be review instead of posting.
- Everything a variant can change is an input: role→model map, knowledge
  ref (a `REVIEW.md` edit under test), method-skill version, pipeline
  options (verifier on/off, reviewer mix).
- Output, as files: each captured review in GitHub review payload shape
  (the same shape as `review-process/Claude outputs/*.json`, so replays and
  hand-made reviews can be compared side by side), the run records, the
  four metrics, and a mechanical diff against the baseline variant: expected
  issues newly hit, **no longer hit**, and new findings on known-clean
  cases.
- Used by: developers changing the bot, the learn job
  ([L-4](04-learning-loop.md#l-4--proposing-reviewmd-changes) step 6), owners
  editing `REVIEW.md` by hand, and model migrations.

For testing the pipeline's own logic, pi's scripted model provider feeds
canned tool calls through the real SDK step, extension and guard. That
proves execution behaviour, not review quality, and is never used to
produce metrics.

## E-5 — Acceptance procedure

For any change to the method, pipeline, pi version, models, or a
repository's `REVIEW.md`:

The bot supplies evidence; people decide.

1. Change **one thing**.
2. Replay baseline and candidate (`tune` while iterating, `held-out` for
   the decision).
3. Attach the replay report and diff to the PR that makes the change.
4. The reviewer of that PR applies RP Loop C's rule: the candidate must
   still catch every known-bad PR the baseline caught, and raise no more
   false alarms on the known-clean PRs. They look at the "no longer hit"
   and "new findings on known-clean" lists — usually a handful of items —
   and judge those, by hand or with a strong model in an interactive
   session.
5. Cost is reported, and is a tiebreaker in early phases, not a gate.

How strictly step 4 treats run-to-run variance ("hit in 1 of 3 runs before,
0 of 3 now") is left to that reviewer rather than encoded as a threshold. A
fixed rule would have to be re-tuned with every model change; the per-run
table gives the reviewer what they need to decide.

**Model change** is the same procedure with the role→model map as the
variable. Models and model versions will change often, so this path must be
cheap: one command, one report. No prompt is written for a particular
model; if a new model needs different instructions, that is a method change
replayed on all candidate models.

## E-6 — Known limits

- Ground truth is incomplete: human reviewers miss bugs too, so a correct
  finding with no label looks "extra" until someone confirms it and adds
  the label.
- A location overlap is not proof that the finding describes the expected
  bug. The mechanical numbers are an upper bound until verdicts are
  recorded in the case files.
- Historical PRs may be in models' training data. Prefer recent PRs for
  `held-out` and refresh it periodically.
- The eval set starts tiny. Until it has a few dozen cases, online outcome
  shares are the more trustworthy signal, and eval results are a regression
  guard rather than a quality measure.

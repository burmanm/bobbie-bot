# 04 — Learning loop

The bot's part of the review process's feedback loops (RP §5.3 and §6,
Loops A and C). It improves review in three ways, in increasing order of
value:

1. It stops saying things people do not want.
2. It starts applying things people do want.
3. It moves recurring model findings into deterministic checks, so the model
   is no longer needed for them ([P-2](README.md#principles)).

The destination of every lesson is something the repository already owns —
lint configuration, a CI check, `REVIEW.md`, `AGENTS.md`, or the shared
guidelines. The bot keeps **no private knowledge format**.

None of the surveyed products documents a concrete rule for step 3; that
part is our own design and the most experimental section of the plan.

## L-1 — Shape of the loop

```
published findings ─▶ harvest outcomes ─▶ cluster ─▶ propose change ─▶ validate by replay ─▶ PR ─▶ code owner merges
        ▲                                                                                              │
        └────────────────────── next reviews read the changed files ◀──────────────────────────────────┘
```

Two scheduled jobs, both offline ([D-9](README.md#key-decisions)):

- **harvest** — deterministic, frequent (daily, and on PR close).
- **learn** — infrequent (weekly or monthly). Its deterministic part
  always runs and updates a report issue; its drafting part uses a model
  and is optional ([L-4](#l-4--proposing-reviewmd-changes)). Its only
  outputs are that report and pull requests ([P-6](README.md#principles)).

Both are **maintenance agents** in the sense of RP `04-maintenance-agents.md`
and follow its rules ([L-8](#l-8--guardrails)). The learn job is the
reviewer-side sibling of RP's *agent-context tuner* (2.2): the tuner asks
"what do authors keep getting wrong?" and edits `AGENTS.md`; the learn job
asks "what does the reviewer keep getting wrong or missing?" and edits
`REVIEW.md`. Both read the same harvested outcomes, so the tuner can be
built on the harvest job's data rather than collecting its own.

## L-2 — Signals

All read from GitHub by the harvest job and joined to findings by the hidden
marker's fingerprint. In keeping with [P-1](README.md#principles) the
primary signal needs no model.

| Signal | How detected | Outcome |
|---|---|---|
| **Reply prefix** `[wrong]`, `[intentional]`, `[not-worth-it]` (RP templates §5) | Text match on thread replies | That category. The one-line reason is kept |
| **Resolved by a code change** | The bot's own "Verified fixed" reply and resolve; or a thread a person resolved after the flagged lines changed | `fixed` |
| **Suggestion committed** | GitHub suggestion applied | `fixed` |
| **Resolved, no prefix, no change** | Thread resolved, lines untouched, no prefix | `unlabelled` — kept as such, with the reply text. Not guessed by a model; the share of unlabelled outcomes is itself reported as a data-quality gap (RP M3) |
| 👍 / 👎 reaction | Reactions API | Secondary; recorded, not required |
| **Missed issue** | A human review comment that led to a code change where the bot had no finding | Recall signal |
| **Escaped bug** | A later PR whose description says `Follow-up to: #N` (RP M2) | Recall signal, and an eval case ([E-2](05-evaluation.md#e-2--corpus)) |
| **Teaching comment** | A maintainer comment tagged `rule:` (RP §5.5) | Direct candidate for a `REVIEW.md` line |

The four outcome categories — `fixed`, `wrong`, `intentional`,
`not-worth-it` — are RP Loop A's, unchanged. High `wrong` or `not-worth-it`
share means noise.

Each harvested item becomes an **outcome** record:
`{fingerprint, runId, outcome, actor role, reason?, at}`.

## L-3 — Where a lesson lands

Cheapest effective place first; this is RP §5.3's order.

| Level | Form | Effect on a review |
|---|---|---|
| 0 Observation | Outcome records in the store | none |
| 1 Lint rule | Change to the repository's linter configuration | CI catches it; reviewer never sees it |
| 2 CI check | Script or program in the repository's check command and CI | Same |
| 3 `REVIEW.md` line | "Focus on", "Don't flag", a clarification, or a skip path | Read by the reviewer on every run |
| 4 `AGENTS.md` line | Convention or verify step (the tuner's territory) | Prevents the mistake at authoring time |
| 5 Shared guideline | Proposal to the source-of-truth repository when the same lesson appears in two or more repositories | Vendored to every repo by the sync tool |

Notes:

- `REVIEW.md` is owner-written and must stay short. The learn job proposes
  **edits** — including deletions and merges — not only additions.
  Provenance (which PRs and findings motivated the change) goes in the pull
  request description, not in the file.
- Vendored shared files are never edited in place (RP D8). For level 5 the
  learn job opens an issue or PR against the source-of-truth repository, or
  proposes a repo-specific exception line in that repo's `REVIEW.md`.
- A mechanical rule that cannot yet be a check may sit in `REVIEW.md`
  marked *(CI)* / temporary, as the pilot file already does. The learn job
  tracks these and proposes the check.

## L-4 — Proposing `REVIEW.md` changes

Steps 1–3 are deterministic and always run. Their result — the clusters,
with links, outcomes and reply reasons — is written to the job's report
issue and exported as data. That alone is useful: an owner, or a person
working with a strong model in an interactive session, can take a cluster
from the report and write the `REVIEW.md` change themselves.

Steps 4–7 need a model (the optional `learner` role). A deployment that
does not configure one stops after step 3.

1. **Select** outcomes since the last run.
2. **Cluster** findings that are "the same kind of comment": group by
   category, cited `REVIEW.md` heading (`ruleRefs`), location pattern and
   outcome. With a `learner` role configured, it may merge or split groups
   by reading them.
3. **Threshold.** A cluster counts only when it spans **at least 3 PRs**
   (the same bar as RP's tuner). One loud reply is not a pattern.
4. **Map cluster to action:**

   | Cluster | Proposed action |
   |---|---|
   | Repeatedly `wrong` for the same pattern | Clarification or "Don't flag" line with the reason taken from the replies |
   | Repeatedly `intentional` | "Don't flag" line naming the intentional pattern and why |
   | Repeatedly `not-worth-it` | Demote to Nit, or "Don't flag" |
   | Repeated missed issues / escaped bugs | "Focus on" line, phrased as the question a reviewer should ask |
   | Human left the same comment twice | Move it into `REVIEW.md` (RP §5.3) |
   | Mostly `fixed` and mechanizable | Go to [L-5](#l-5--promotion-to-a-deterministic-check) instead |

5. **Draft** the edit, scoped as narrowly as the evidence allows.
6. **Validate by replay** ([E-4](05-evaluation.md#e-4--replay-harness)):
   re-run the source PRs with the edited `REVIEW.md`. A "Don't flag" line
   must remove the unwanted findings and must not remove any finding whose
   outcome was `fixed`. A "Focus on" line must produce the missed finding on
   the source PRs. These are mechanical comparisons by fingerprint and
   location. The eval-set replay report is attached as well, for the PR's
   reviewer to judge under
   [E-5](05-evaluation.md#e-5--acceptance-procedure).
7. **Open a PR** with the edit, the evidence ("seen in #12, #15 and #19"),
   and the replay report. Code owners of `REVIEW.md` approve.

## L-5 — Promotion to a deterministic check

Inputs: the `mechanizable` field every reviewer fills in
([A-3](02-architecture.md#a-3--finding)), plus outcomes.

Codemode scripts saved with run records
([A-6](02-architecture.md#a-6--run-record)) are a possible further input.
Whether any are usable as detectors is evaluated in
[R-6](07-roadmap.md#r-6--promotion-to-checks) before anything depends on it.

A cluster is a **check candidate** when its findings are mostly marked
mechanizable, it spans at least 3 PRs, and its outcomes are mostly `fixed`.

The learn job then:

1. **Chooses the cheapest adequate mechanism**: enable or configure an
   existing linter rule → AST pattern rule → small script or Go program in
   the repository's check command. Prefer configuration over new code.
2. **Builds fixtures from history.** The flagged snippets are must-flag
   cases; the fixed versions from the same PRs are must-not-flag cases.
3. **Meets RP §3.1's "evidence must be able to fail".** The check ships
   with a test that makes it fail on purpose, and every run prints how much
   it looked at ("checked 14 files") so that a check silently checking
   nothing is visible.
4. **Runs it over the default branch and the eval corpus** and lists the
   hits. Hits on code that was never flagged, or was accepted by reviewers,
   are probable false positives.
5. **Opens a PR against the repository** adding the check to CI and to the
   local check command, **and deleting the corresponding `REVIEW.md` line**
   in the same PR (RP §3.1: when the check exists, the line goes).

After merge the reviewer no longer reports that class, because `REVIEW.md`'s
"Don't flag: anything a CI check enforces" covers it. That is how model
spend on a class of issue goes to zero.

The bot does not host or run these checks. Where a lint change needs the
codebase fixed first, the PR says so and it becomes readiness work, not an
automatic change.

## L-6 — Pruning

Knowledge that only grows becomes noise, and RP §5.3 schedules a quarterly
prune by owners. The learn job supplies the data for it in its report: per
`REVIEW.md` line, how often it was cited by a finding (`ruleRefs`) and the
outcome mix of those findings. It proposes removing lines that have not
been cited in a long window. Owners decide.

It also supplies RP D5's spot-check ("does the reviewer follow
`REVIEW.md`?") with a sample of reviews and the lines they applied.

## L-7 — Teaching and interviewing, outside the bot

A separate activity from the bot, and deliberately so. The expected setup
is that the bot reviews with an inexpensive model, while a stronger model
is used by people interactively (for example in Claude Code) and is not
wired into CI at all. That stronger session can:

- **interview a review** — read a run record and the PR, and question what
  the reviewer traced, assumed, missed or got wrong;
- **re-review** a PR independently and compare;
- **judge** replay results for an acceptance decision
  ([E-0](05-evaluation.md#e-0--what-is-in-the-bot-and-what-is-not));
- **write the lesson** as a change to `REVIEW.md`, the shared guidelines,
  or the bot's method skill.

What the bot owes this activity:

- **Run records worth interviewing**: every finding including dropped ones
  with reasons, what was traced versus assumed, which knowledge was loaded,
  and per-step usage ([A-6](02-architecture.md#a-6--run-record)).
- **A replay command** that re-runs any past PR with a given configuration
  and writes the result as files
  ([E-4](05-evaluation.md#e-4--replay-harness)).
- **An import path for independent reviews**: a review produced elsewhere,
  in the same payload shape, can be dropped next to a replay and diffed
  mechanically against it.
- **One way in for lessons**: they arrive as ordinary pull requests to the
  repository's files or to the method skill, and are checked by replay like
  any other change. A lesson only the cheaper model needs belongs in the
  method skill, not in a repository's `REVIEW.md`.

## L-8 — Guardrails

From RP `04-maintenance-agents.md` §1, applied to harvest and learn:

- **Report-only start.** The learn job first runs for a few cycles writing
  only its report issue. It opens PRs once its owner trusts the proposals.
- **Review budget.** At most 1–2 open learn PRs per repository. Further
  proposals wait in the report.
- **No duplicates.** Output is labelled `agent/review-learn`. Before
  proposing, check open PRs and issues, and ones closed as won't-fix; a
  rejected proposal does not come back.
- **Kill switch.** A repository variable disables each job without a PR.
- **Named owner** for the job; **measured** by proposals merged vs closed
  unmerged — retune or switch off below roughly 50 % acceptance.
- **Least privilege.** Pushes only to `agent/*` branches.
- **Same report envelope** as the other tools (RP `04-maintenance-agents.md`
  §6), `tool: "review-bot"`.

Specific to learning:

- Reply and comment text is untrusted input to the `learner` role. It has
  no tools beyond reading the store and writing a proposal.
- Only maintainers' outcomes count towards thresholds. Outside
  contributors' replies and reactions are recorded but not counted.
- Nothing learned takes effect until merged to the default branch
  ([D-7](README.md#key-decisions)).

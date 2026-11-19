# 03 — Review pipeline

One run reviews one PR head SHA. Stages S-1 to S-3 and S-6 to S-8 are
deterministic code. Only S-4 and S-5 call a model. The output contract is
set by the review process: see
[09-process-integration.md](09-process-integration.md#i-2--contract-the-bot-must-honour)
(cited below as *I-2 #n*).

| Stage | Model? | Output |
|---|---|---|
| [S-1 Intake](#s-1--intake) | no | PR snapshot, prior state, go/skip decision, check run opened |
| [S-2 Deterministic pass](#s-2--deterministic-pass) | no | File set, per-file patches |
| [S-3 Context](#s-3--context) | no | Shared context file |
| [S-4 Review](#s-4--review) | yes | Proposed findings, questions, needs-human notes |
| [S-5 Verify](#s-5--verify) | partly | Findings marked verified / unverified / refuted |
| [S-6 Reconcile](#s-6--reconcile) | no | What to post, which threads to answer |
| [S-7 Publish](#s-7--publish) | no | One review, thread replies, check run completed |
| [S-8 Record](#s-8--record) | no | Run record |

## S-0 — Run directory

Every stage reads its input from and writes its output to a run directory
(`<tmp>/run-<id>/NN-stage.json`, plus `patches/`, `context.md`). Any stage
can be re-run from the previous stage's file, the eval harness can inject
recorded inputs, and prompts never carry large blobs — models read files
with tools.

## S-1 — Intake

- Open the check run `ai-review/<name>` on the head SHA as *in progress*
  (I-2 #1). From here on every exit path completes it.
- Resolve PR metadata: base and head SHA, title, description (including the
  template sections *Intent*, *Intentional trade-offs*, *Risk*), linked
  issues, author, labels, and **all existing review comments** — humans',
  other bots', and this bot's.
- Authorization ([C-4](06-ci-and-security.md#c-4--fork-pull-requests-and-authorization)):
  automatic review only for maintainers' PRs; others need a maintainer's
  label. Not authorized → complete the check as *skipped* and stop.
- CI ([C-9](06-ci-and-security.md#c-9--waiting-for-ci)), when the
  repository requires it: the gate has already established that CI passed
  on this head SHA, or the run was dispatched with `--ignore-ci`. Intake
  records the CI wait for the run record.
- Source snapshots: the head tree and base tree arrive as **data** prepared
  by an unprivileged job. Knowledge is read from the base
  ([C-3](06-ci-and-security.md#c-3--trust-model)).
- Load prior bot state from GitHub: this bot's earlier comments, their
  fingerprints, and the last-reviewed SHA from hidden markers.
- Scope: **full** (first run or base changed) or **incremental** (only
  `lastReviewedSha..head`, plus re-checking earlier open findings; I-2 #9).
- Skip conditions (configurable): draft, `deps`-labelled dependency-only
  PRs, opt-out label, `round-cap` label, repository has no `REVIEW.md`
  ([A-5](02-architecture.md#a-5--knowledge-sources)). A skip completes the
  check as *skipped* and writes a run record.

## S-2 — Deterministic pass

- **Skip paths.** Binary files are always skipped. Everything else comes
  from the repository: glob entries under the "Skip these paths" heading of
  `REVIEW.md` are parsed mechanically. An entry with a qualifier in prose
  ("unless the PR's purpose is test data") is not hard-filtered; it is left
  to the reviewer, which reads `REVIEW.md` anyway. Each exclusion is
  recorded with its reason.
- **Split the diff** into one patch file per changed file under `patches/`.
- **No checks are run here.** Lint and deterministic checks are the
  repository CI's job (RP §3.1). The bot does not duplicate or host them.
- **Read-only inputs from CI, when present:** output of the `needs-human`
  detector (RP T17) so the reviewer does not have to rediscover it. Absent
  that, the reviewer notes these itself (S-4), marked temporary.

## S-3 — Context

Write one `context.md` shared by every model step:

- PR intent and stated trade-offs, delimited as untrusted data.
- Change map: file list with sizes and patch file paths.
- Knowledge, verbatim from the base branch: `AGENTS.md`, the applicable
  `REVIEW.md` file(s), vendored shared guidelines.
- Existing comments on the PR from anyone, so nothing is repeated.
- For incremental runs: earlier findings with thread state and replies.

No codebase index, embedding store or dependency graph in the first phases;
the reviewer has the source snapshot and search tools.

## S-4 — Review

**Tools available to the reviewer:** read file, list, grep/find over the
head snapshot, the base snapshot, and the Go module cache (read-only);
read-only history queries served by the orchestrator through the GitHub API
(log, blame, commit diff — there is no `.git` to run commands in); a
read-only issue search scoped to the repository (for I-2 #4); and three
typed output tools:

- `report_finding` — [A-3](02-architecture.md#a-3--finding).
- `ask_question` — for stated trade-offs that may lead to a failure
  (I-2 #6), and for environment-dependent impact that cannot be shown.
- `note_needs_human` — `{what, locations[], explainedInDescription}`
  (I-2 #5).

Path arguments of the read tools are confined to those roots by our guard,
after symlink resolution; pi does not do this itself
([C-3](06-ci-and-security.md#c-3--trust-model)). The search tools ignore
any `.gitignore`, `.ignore` or similar file in the snapshot: pi's own
`find` and `grep` honour them, so the bot replaces or wraps those tools. A
PR must not be able to hide a file from the reviewer, and a PR's change to
such a file is itself reviewed.

No write, no network, no shell, no execution of any code. Consequently the
reviewer cannot run tests or probes; anything it would have needed to run
is listed under "Not run" in the summary
([I-5](09-process-integration.md#i-5--gaps-this-exposes-in-review-process-to-raise-there)).

**Method** (a skill shipped with the bot; it describes *how* to review, never
*what matters* — that is `REVIEW.md`):

1. Read `context.md`, then the patches.
2. For each suspected problem, read the surrounding code, callers and tests.
   Trace every function the mechanism names; say what was traced and what
   was assumed (I-2 #12).
3. Form a hypothesis, then try to disprove it.
4. A claim about library behaviour cites the library source at the pinned
   version in the module cache.
5. Classify: introduced by this PR (Important or Nit) or already there
   (Pre-existing).
6. One finding per problem; list every location (I-2 #10).
7. Record what was checked and found clean, briefly.

**Shape, by phase:**

- *Phase 1:* one generalist reviewer step. Large PRs are chunked by
  directory into several steps sharing `context.md`.
- *Later, eval-gated:* a mix of quick whole-change and deep risky-part
  reviewers. A separate **security pass** (RP layer 4) is another reviewer
  with its own check run `ai-review/security`.

**Limits** (safety, not optimization): per-step timeout and turn cap,
per-run spend cap, inactivity timeout. A timed-out step is recorded and the
run continues with what it has.

## S-5 — Verify

**Mechanical grounding (code):**

- Each `evidence.quote` must appear at the cited path and lines — in the
  head snapshot, or in the module cache for library citations. Otherwise →
  `refuted: evidence not found`.
- Important and Nit anchors must fall inside the PR diff. A finding
  anchored outside it is re-tagged Pre-existing or moved to the summary.
- Schema validity is already enforced by pi when the tool is called — an
  invalid call is returned to the model as an error and never reaches the
  orchestrator as a finding. Cross-field rules (for example `proposedIssue`
  only on Pre-existing) are checked in the tool itself. The orchestrator
  re-validates only as defence in depth.
- Fingerprint not already posted on this PR.

**Adversarial verification (model, `verifier` role):** a fresh session per
finding with the same read-only tools, given only the finding and the
snapshots. Its task is to *disprove* the finding by reading code (this is
RP's "conclusions from subagents are claims to verify"). It returns
`submit_verdict`:

- `refuted` — with evidence proving the finding wrong. Dropped.
- `confirmed` — kept as `verified`.
- `inconclusive` — kept as `unverified`, and labelled so when posted.

Drop only on proof. No filtering on a quality score.

Nits are verified mechanically only; spending a model step on a nit is not
worth it.

## S-6 — Reconcile

- Deduplicate within the run by fingerprint, then by overlapping location
  and category.
- Against existing comments on the PR (I-2 #9):
  - same issue already raised by anyone, thread open or resolved → do not
    post again;
  - this bot's earlier finding, thread still open → re-check it against the
    new head and prepare a **thread reply**: "Verified fixed at `<sha>`"
    with what was checked, or "Still open at `<sha>`" with the remaining
    case.
- Apply limits from `REVIEW.md` (for example at most 3 Nits). Dropped nits
  are recorded, not posted. Important findings are never capped.

## S-7 — Publish

Performed by code with the write token; no model involved.

- **One** review per run, event `COMMENT` (I-2 #8), with inline comments for
  Important and Nit findings. Each comment starts with its tag (I-2 #3).
- **Thread replies** on this bot's earlier findings (from S-6). A thread the
  bot verified as fixed is also **resolved** by the bot, after the reply.
  The bot resolves only its own threads and only on "verified fixed"; a
  "still open" thread, a thread answered with `[wrong]` / `[intentional]` /
  `[not-worth-it]`, and anyone else's thread are left for people to resolve.
- **Summary body** (I-2 #11), assembled by code from typed parts:
  1. Round and commit range covered.
  2. Count line: "N important, M nits, K pre-existing", or a plain statement
     that there is nothing to fix.
  3. Earlier findings: still open / verified fixed.
  4. Pre-existing items, each with a proposed `tech-debt` issue title or a
     link to the existing issue (I-2 #4).
  5. Questions.
  6. Checked, nothing found.
  7. Not run / partial-run note.
  8. How to resolve: `[wrong]`, `[intentional]`, `[not-worth-it]`.
  9. `Needs human: <what> in <file:line>. Explained in the description: yes/no.`
- Hidden HTML marker on every comment: bot ID, run ID, fingerprint,
  `fingerprintVersion`. The summary carries the last reviewed SHA. This is
  the bot's whole per-PR state ([D-5](README.md#key-decisions)). The bot
  recognises its own comments by marker, not by author login, because under
  the Actions token the login is shared with other workflows.
- **Complete the check run** `ai-review/<name>` with a conclusion and a
  one-line summary. The conclusion reports whether the *review ran*, not
  whether findings exist: `success` (reviewed), `skipped`, or `neutral`
  (could not complete). Open Important findings block merging through
  conversation resolution, not through this check.

## S-8 — Record

Write the run record ([A-6](02-architecture.md#a-6--run-record)) and upload
it as a workflow artifact. The review job writes nowhere else
([A-7](02-architecture.md#a-7--store)). Recording failures never affect the
review.

## S-9 — Failure behaviour

- **The check run is always completed** — on success, skip, timeout, model
  error, and crash (a final always-run step). An unfinished check would
  hold the PR in `review/bots` indefinitely.
- On internal failure: conclusion `neutral`, one short "review could not
  complete" comment updated in place (not repeated per push), and the PR
  proceeds to humans.
- Partial results are published and labelled partial in the summary.
- Provider errors: bounded retry with backoff. No automatic model failover
  in the first phases.
- A newer push cancels the in-flight run for the same PR; the cancelled
  run's check is superseded by the new head SHA's.

# 07 — Roadmap

Phases are ordered so that real usage starts early and measurement exists
before anything is tuned. Each phase has an exit criterion.

Relation to the review process's rollout (RP `01-steps.md`): the bot is what
RP Phase 5 integrates (RP T3). A repository gets the bot only after RP
Phase 2 (docs exist) and Phase 3 (repository readiness). R-0 to R-2 can be
built meanwhile and exercised in dry-run against the pilot.

## R-0 — Spike: pi integration — done

**Done 2026-11-15.** Results in
[spike-r0-findings.md](spike-r0-findings.md); the throwaway scripts are in
`spike/`. Outcome: SDK chosen, pi pinned to 1.5.2, `AgentStep` signature
proposed. It used a synthetic Go snapshot, not a cass-operator PR. Its
corrections to the trust model are in
[C-3a](06-ci-and-security.md#c-3a--pi-session-isolation).

Original scope: answer every question in
[F-6](01-foundation-pi.md#f-6--to-verify-in-the-phase-0-spike).

Deliver: a throwaway script that, through the pi SDK with an OpenRouter
model, runs one session with only read-only tools and `report_finding`
against an extracted snapshot of a cass-operator PR, loads nothing from the
snapshot's `.pi/`, and prints typed findings and token usage.

Exit: `AgentStep` interface agreed; SDK vs subprocess chosen; pi version
pinned.

## R-1 — Minimum useful reviewer (dry-run)

- `core`: types, diff parsing, fingerprint, `REVIEW.md` section parsing,
  summary assembly.
- Pipeline S-1 → S-4 (single reviewer) → mechanical grounding → S-6 → S-7 →
  S-8, with a `Platform` that prints instead of posting.
- Knowledge from the repository's `AGENTS.md`, `REVIEW.md` and vendored
  guidelines only ([A-5](02-architecture.md#a-5--knowledge-sources)).
- Output contract of
  [I-2](09-process-integration.md#i-2--contract-the-bot-must-honour): tags,
  pre-existing in summary, needs-human line, questions, summary format.

Exit: dry-run output on the PRs already reviewed by hand in
`review-process/Claude outputs/` is comparable in form, and an owner judges
it worth piloting.

## R-1a — pi-native configuration

Before R-2 fixes the workflow inputs, so nothing has to be migrated later
([F-7](01-foundation-pi.md#f-7--configuration-follows-pi)).

- Answer F-7's five verification questions against pi 1.5.2.
- The runner takes an operator pi agent directory (`settings.json`,
  `models.json`); role models in pi's `provider/id[:thinking]` syntax;
  remove the bot's own `thinking`, `providers` and `routing` fields in
  favour of pi's.
- Pi packages from `settings.json` `packages` or listed local
  `node_modules` paths; `review-bot setup` installs them before secrets
  exist. Loaded packages and versions in the run record.
- Isolation regression test extended: an operator directory with a
  package loads that package and nothing from the snapshot; an
  `AGENTS.md` or `SYSTEM.md` in the operator directory is refused.
- `.review/review-bot.yaml` limited to choosing among `enabledModels` and
  lowering limits.

Exit: a provider that pi does not ship (a pi provider package, or a
`models.json` endpoint) is used for a dry run with no code change, and the
same agent directory works for `/review` in pi.

## R-2 — Live on the pilot

- GitHub `Platform`: review, thread replies, check run `ai-review/<name>`.
- Workflow with gate / prepare / review jobs; fork PRs; maintainer-only
  automatic review ([C-4](06-ci-and-security.md#c-4--fork-pull-requests-and-authorization)).
- Both identities ([C-5](06-ci-and-security.md#c-5--credentials-and-identity)).
- Go preparation step (module cache).
- Limits and failure behaviour; trust model in full, including the pi
  isolation regression test and `rg`/`fd` shipped in the action image
  ([C-3a](06-ci-and-security.md#c-3a--pi-session-isolation)) — not
  deferrable.
- Run record as artifact, with CI-wait and queue timestamps
  ([A-6](02-architecture.md#a-6--run-record)).
- Waiting for CI, opt-in per repository
  ([C-9](06-ci-and-security.md#c-9--waiting-for-ci)): gate check of the
  required checks, `workflow_run` / `status` re-triggers, timeout sweep.

Exit: runs on real cass-operator PRs, non-blocking (RP 5.9); every run
completes its check and leaves a record.

## R-3 — Measurement

- Harvest job and store ([A-7](02-architecture.md#a-7--store)); outcomes
  from reply prefixes ([L-2](04-learning-loop.md#l-2--signals)).
- Eval set: known-bad and known-clean PRs
  ([E-2](05-evaluation.md#e-2--corpus)); replay harness with mechanical
  diff. Judging stays outside the bot.
- Loop A report: `fixed` / `wrong` / `intentional` / `not-worth-it` shares,
  rounds-to-pass.
- Production metrics ([10-metrics.md](10-metrics.md)): per-PR metrics
  record written by the harvest job — cost, runs, rounds, findings by tag,
  rejected inside the bot and by people, human comments, missed findings,
  and timings (time to first bot review, bot phase, time to human-approval
  request, human review until merge). Weekly aggregate table in the report
  issue.

Exit: baseline numbers on the eval set; the acceptance procedure
([E-5](05-evaluation.md#e-5--acceptance-procedure)) is usable.

Placed before further pipeline work on purpose: everything after this is
justified by it.

## R-4 — Precision and convergence

- Adversarial verifier ([S-5](03-review-pipeline.md#s-5--verify)).
- Incremental re-review with "verified fixed / still open" replies; no
  repeats across bots and humans.
- Per-area `REVIEW.md`.

Exit: `wrong` share lower than the R-3 baseline with no known-bad case
lost; rounds-to-pass not higher.

## R-5 — Learning

- Learn job: deterministic cluster report first; optional model drafting
  and PRs to `REVIEW.md` later
  ([L-4](04-learning-loop.md#l-4--proposing-reviewmd-changes)).
- Pruning and follow-`REVIEW.md` data
  ([L-6](04-learning-loop.md#l-6--pruning)).

Exit: at least one cycle where merged proposals pass E-5 and the `fixed`
share does not fall.

## R-6 — Promotion to checks

- Check-candidate detection, fixtures, PR adding the check and deleting the
  `REVIEW.md` line
  ([L-5](04-learning-loop.md#l-5--promotion-to-a-deterministic-check)).

Exit: at least one class of finding moved from model to CI.

## R-7 — Scale-out (each item eval-gated)

- Security pass as a second reviewer with its own check run (RP layer 4).
- Reviewer mix and specialists.
- More languages: TypeScript, Java, Python preparation steps. The pipeline
  itself is language-neutral; only `prepare` and the shared guidelines
  differ.
- Cost work (below).
- Integrations through pi packages / MCP: issue tracker context, chat.
- Import and diff of independently produced reviews
  ([L-7](04-learning-loop.md#l-7--teaching-and-interviewing-outside-the-bot)).
- Metrics export to an external backend through `MetricsSink` (OTLP
  first), from the harvest job only
  ([O-2](10-metrics.md#o-2--how-the-numbers-are-collected)).
- ACP agents as a pi provider package, so they too are configured in
  `settings.json` ([F-7](01-foundation-pi.md#f-7--configuration-follows-pi)).

## Deferred on purpose

**R-D.** Known techniques, listed so nobody rediscovers them, and not to be
started before R-3 data shows the need ([P-9](README.md#principles)).

| Idea | Source | Notes |
|---|---|---|
| Risk tiers: fewer/cheaper steps for small or low-risk diffs | Cloudflare | Largest reported lever; needs our own cost distribution first |
| Role tiering: cheap model for triage/docs, strong for coordination | Cloudflare, agentrun | Role map already supports it |
| Prompt caching of the shared prefix | Cloudflare, Greptile | `context.md` is already a shared, stable prefix by design |
| Cheap pre-filter choosing which files the strong model reads | Greptile | |
| Multiple passes with shuffled diff order + majority vote | Cursor Bugbot (early version) | Costly; they later moved away from it |
| Embedding-based clustering of feedback | Greptile | Only if L-4 grouping is the bottleneck |
| Codebase index / dependency graph | Greptile, CodeRabbit | Agentic search first |
| Reviewer model family different from the author's | Greptile | Their own measured gain was small (2–3 points) |
| Sandboxed execution: probes, `go test`, dynamic testing | RP T3, Greptile | Needs a real sandbox and changes the trust model; the point at which Pi Durable is worth revisiting |
| Provider failover / circuit breakers | Cloudflare | Operational maturity, not needed for pilots |

## Open questions

### Decided (2026-11-15)

| ID | Question | Decision |
|---|---|---|
| Q-1 | Bot identity | Support both a GitHub App and the Actions token; no personal access tokens ([C-5](06-ci-and-security.md#c-5--credentials-and-identity)) |
| Q-2 | Fork PRs | In scope and the main path. Automatic review for maintainers only; others by maintainer label ([C-4](06-ci-and-security.md#c-4--fork-pull-requests-and-authorization)) |
| Q-3 | Where records live | Review job uploads an artifact only; the scheduled harvest job writes to a per-organization reports repository, with object storage as an alternative ([A-7](02-architecture.md#a-7--store)) |
| Q-4 | One repository or many | Design for many, deploy to one or two |
| Q-5 | Languages | Go first (first two repositories); TypeScript, Java, Python later |
| Q-6 | Model provider | OpenRouter to start ([C-6](06-ci-and-security.md#c-6--model-provider)) |
| Q-7 | Who approves learn-job PRs | Code owners of the changed file |
| Q-8 | Posting `unverified` findings | Decide from R-4 eval data |
| Q-9 | Resolving threads | The bot replies and resolves its own thread when it verifies the finding as fixed; it never resolves anything else ([S-7](03-review-pipeline.md#s-7--publish)) |
| Q-10 | Authorization label | Configurable: the label name and whether it is removed on the contributor's next push or persists for the PR. Defaults: `ai-review/approved`, removed on each push |
| Q-11 | Defining "caught" under model variance | Not encoded in the bot. Replay reports every run and a mechanical diff; judging and the accept/reject decision happen outside the bot ([E-0](05-evaluation.md#e-0--what-is-in-the-bot-and-what-is-not)) |
| Q-12 | Learn job and agent-context tuner | Build the learn job; expose the harvested data so the tuner can be added later |
| Q-13 | Acceptable models and upstream providers | Owners decide per organization, and enforce it on the provider side (an OpenRouter key can be restricted to specific models). The role→model map is plain configuration because it will change often ([C-6](06-ci-and-security.md#c-6--model-provider)) |
| Q-14 | A PR's `.gitignore` hiding files from the reviewer's search | Never allowed. No file in the PR changes what the reviewer can see or how the bot behaves; the search tools ignore the snapshot's ignore files, and a PR's changes to such files are reviewed like any other change ([C-3](06-ci-and-security.md#c-3--trust-model)) |
| Q-15 | How the extension is loaded | Both: the runner passes it in-process; the package also exposes it by path for interactive `/review` |
| Q-16 | Cost of timed-out steps | Mark the step `usageComplete: false` and report how many there were; no estimate. Totals can be reported with and without such steps if needed ([A-6](02-architecture.md#a-6--run-record)) |
| — | Built-in review guidance | None; knowledge comes from the repository ([A-5](02-architecture.md#a-5--knowledge-sources)) |
| — | Approval flow (state labels, human review requests) | Lives in review-process, not in the bot ([I-1](09-process-integration.md#i-1--what-lives-where)) |

### Open

| ID | Question | Leaning |
|---|---|---|
| Q-17 | When CI fails and the bot's check completes *skipped*, how does the review-process state workflow keep the PR away from people? | Raise in review-process ([I-5](09-process-integration.md#i-5--gaps-this-exposes-in-review-process-to-raise-there)); `ci.onFailure: skip` by default until it is settled |
| Q-18 | Which event is the "human-approval request" for timings? | First `review/human` label, falling back to the first review request to a person; configurable until review-process defines it ([O-1](10-metrics.md#o-1--what-is-measured)) |
| Q-19 | Should pure process timings be computed by the harvest job or read from `review-metrics`? | Harvest computes them with `review-metrics`'s definitions; switch to reading them if `review-metrics` publishes per-PR records ([O-3](10-metrics.md#o-3--relation-to-review-metrics)) |
| Q-20 | Do pi's settings tolerate bot keys, so the bot's settings could live in `settings.json` too? | Keep a separate bot file unless F-7 verification shows a supported place for extension settings |

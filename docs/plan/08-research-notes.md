# 08 — Research notes

Digest of the sources behind the plan, gathered 2026-11-15. Pages were read
by extraction agents through a summarizing fetch, so **figures are as
reported by those summaries and should be re-checked at the source before
being quoted elsewhere.** Vendor numbers are self-reported.

## review-process (internal)

Source: local checkout of `github.com/burmanm/review-process` at `6537fb1`
(`00-plan.md`, `01-steps.md`, `02-open-questions.md`, `03-templates.md`,
`04-maintenance-agents.md`, `pilot/cass-operator/`, `Claude outputs/`). Read
directly, not through a summarizer. It is the governing input; its effect on
this plan is recorded in
[09-process-integration.md](09-process-integration.md).

## pi

Sources: <https://pi.dev>, <https://github.com/earendil-works/pi>
(`packages/coding-agent/docs/{extensions,skills,packages,settings,providers,cli,rpc,sdk}.md`,
`packages/durable/README.md`), <https://earendil.com/posts/pi-durable/>.

- Repo moved from `badlogic/pi-mono` to `earendil-works/pi`; npm scope is
  `@earendil-works/*`. MIT. Node `>=22.19.0`. Versions 1.5.2 (coding agent
  and durable).
- Extension API: default-export factory receiving `ExtensionAPI`;
  `registerTool`, `registerCommand`, `registerFlag`, `registerProvider`,
  `registerMcpServer`, `on(event)`. Events include `tool_call`,
  `tool_result`, `agent_end`, `agent_settled`, `before_provider_request`,
  `session_start`. `ctx.hasUI` / `ctx.mode` for headless guards.
- Discovery: `~/.pi/agent/extensions/`, project `.pi/extensions/` (only after
  project trust), or `pi.extensions` in a package manifest. Install with
  `pi install npm:… | git:…`.
- Headless: `-p`, `--mode json` (JSONL events), `--mode rpc`; tool flags
  `-t`, `-nbt`, `-nt`, `-xt`; `--model provider/id`; `--no-session`.
  SDK: `createAgentSession({model, tools, customTools, sessionManager,
  resourceLoader, …})`.
- No built-in sub-agents; `examples/extensions/subagent/` shows the pattern.
- No schema-validated final output; hence our typed-tool approach.
- Pi Durable: checkpointed task runtime; storage backends memory / SQLite /
  JSONL / Durable Objects / IndexedDB; README says experimental, API changes
  without notice.
- Existing review work: `earendil-works/pi-review` (interactive),
  `shaftoe/pi-coding-agent-action` (trusts the project in CI),
  `pi-pr-review` (community).
- **Unverified:** see [F-6](01-foundation-pi.md#f-6--to-verify-in-the-phase-0-spike).

## agentrun (Parcha / Grep.ai)

Sources: <https://github.com/Parcha-ai/agentrun> README,
`docs/case-studies/code-review.md`,
`docs/case-studies/merchant-classification.md`, workflow guide. Apache-2.0.
Runs on top of harnesses including pi.

Principles taken:

- Typed model output, code-controlled execution. → [P-1](README.md#principles), [P-3](README.md#principles)
- Code for what is certain; route on a stored decision rather than asking
  the model twice. → [P-1](README.md#principles)
- Confidence is a model output, not calibrated accuracy. → [A-3](02-architecture.md#a-3--finding)
- Scripted responses prove execution, not quality. → [E-4](05-evaluation.md#e-4--replay-harness)
- Learning ladder notes → skill → workflow, committed to git. → [L-3](04-learning-loop.md#l-3--where-a-lesson-lands)

Code-review case study: parent + 8 read-only reviewers (5 quick over the
whole change, 3 deep on risky parts); comment-only; parent drops a finding
only when code proves it wrong (an earlier version dropped unprovable ones
and lost real bugs). Tuned on 70 merged PRs, newest 30 held out. Reported:
~$0.18 per review; real bugs caught 42% vs 26% for the hosted tool it
replaced; serious bugs 5 of 8 vs 1; wrong-finding rate 70% diff-only vs 7%
with a read-only shell; mixed reviewers beat uniform; an uncounted timeout
distorted one comparison by 15 points. Four metrics: bugs caught, serious
bugs caught, wrong findings, cost. `docs/CODEREVIEW.md` holds what matters
and what never to flag.

Merchant-classification case study: strong model works with learning on and
is told the right answer after each run; it distils a workflow; a cheap
model runs the workflow with a judge that checks quoted evidence appears on
a page actually read, handing back to the strong model otherwise. Reported
cost $0.89 → $0.124 per item with accuracy 93% → 96%. Sealed held-out set.
→ [L-7](04-learning-loop.md#l-7--teaching-and-interviewing-outside-the-bot), evidence
grounding in [S-5](03-review-pipeline.md#s-5--verify).

Not covered by the source: how review feedback is stored or promoted into
rules; any general "promote to script" mechanism. Our [L-5](04-learning-loop.md#l-5--promotion-to-a-deterministic-check) is original.

## Greptile

Sources: `/blog/how-to-build-a-code-review-agent`, `/blog/make-llms-shut-up`,
`/blog/greptile-v3-agentic-code-review`, `/blog/greptile-v5`,
`/blog/model-inversion`, `/blog/ai-code-reviews-conflict`,
`/blog/semantic-codebase-search` on <https://www.greptile.com>.

- Moved from a fixed pipeline (diff → codebase context → external context →
  comments) to an agent loop with tools; then to parallel agents each
  testing one candidate bug. Narrow agent tasks perform better.
- Agent forms a hypothesis and tries to disprove it. → [S-4](03-review-pipeline.md#s-4--review), [S-5](03-review-pipeline.md#s-5--verify)
- Noise: early comments were ~19% good, 2% wrong, 79% nits. Prompting and
  few-shot did not fix it. LLM-as-judge 1–10 scoring was near random.
  What worked: per-team embeddings of up/down-voted comments; a new comment
  is blocked when similar to ≥3 distinct downvoted ones. Address rate 19% →
  55%+.
- Signals: was the comment addressed in later commits; votes; replies.
  Address rate is the main metric. → [L-2](04-learning-loop.md#l-2--signals), [E-3](05-evaluation.md#e-3--metrics)
- Reviewer from a different model family than the author: measured gain 2–3
  points of recall. Small.
- Cost notes: cheap model pre-filters files; caching matters.

## Cloudflare

Source: <https://blog.cloudflare.com/ai-code-review> ("Orchestrating AI Code
Review at scale", April 2026).

- Coordinator + specialist sub-reviewers (security, performance, code
  quality, docs, compliance); structured output with severity
  critical / warning / suggestion.
- Per-file patch files on disk and one shared context file instead of
  repeating context per reviewer. → [S-2](03-review-pipeline.md#s-2--deterministic-pass), [S-3](03-review-pipeline.md#s-3--context)
- Drops lock files, minified and generated files before review.
- Explicit "What NOT to Flag" sections credited for low noise; ~1.2 findings
  per review.
- Incremental re-review aware of earlier findings; fixed items auto-resolve;
  a "won't fix" reply counts as resolution. → [S-6](03-review-pipeline.md#s-6--reconcile)
- Risk tiers by diff size (trivial / lite / full) set agent count and model
  tier. Reported cost: median $0.98, mean $1.19, p99 $4.45; cache hit rate
  85.7%.
- Operational lessons: pass prompts by stdin (argument length limits);
  heartbeat during long thinking; per-task and overall timeouts; failover
  only for provider errors, not auth/context errors.
- No learning from feedback described; no labelled-accuracy evaluation.

## Other reviewers

Coverage here is thinner; several product details are from search snippets.

- **CodeRabbit** (blog + docs): sandboxed clone; 30–40+ linters/SAST run
  before the model; verification step on drafted comments;
  `path_instructions` (glob + text); ast-grep rules. *Learnings*: created
  from replies to the bot, stored per organization, scoped local/global,
  PR-sourced learnings inactive until merge, optional approval delay,
  admin-editable. → [L-4](04-learning-loop.md#l-4--proposing-reviewmd-changes), [L-8](04-learning-loop.md#l-8--guardrails)
- **Kodus** (`kodustech/kodus-ai`, docs): *Kody Rules* scoped
  org/repo/path; rule suggestions generated from review history and approved
  by a human; thumbs and "implemented" as signals; ignored suggestions
  tracked as issues and auto-resolved when a later PR fixes them;
  per-PR/per-file caps and a severity threshold.
- **Qodo PR-Agent** (`qodo-ai/pr-agent` docs): token-budgeted patch packing
  (order by language and size, additions over deletions); self-reflection
  scoring of suggestions (since retired); auto best practices derived
  periodically from accepted suggestions and stored in a repo wiki file
  (snippet-level).
- **GitHub Copilot code review** (changelogs): agentic, tool-calling for
  repository context; user-selectable deterministic engines (CodeQL, ESLint,
  PMD); runs on GitHub Actions.
- **Cursor Bugbot** (blog): early design ran 8 passes over differently
  ordered diffs with majority voting and a validator; later fully agentic.
  Headline metric is *resolution rate* — an LLM judges at merge time which
  flagged bugs were fixed. → [E-3](05-evaluation.md#e-3--metrics)
- **Claude Code review plugin**: parallel reviewers plus per-finding
  confidence threshold — unverified against the primary source.

Patterns shared by three or more: path-scoped natural-language rules;
learning from human feedback behind a human gate; a verification or
multi-pass step to cut noise. Combining static analysis with the model is
explicit in CodeRabbit and Copilot.

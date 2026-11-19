# Running a dry run

`review-bot review --dry-run` runs the whole pipeline (S-0 to S-8) on one
pull request and **prints** the review it would post. Nothing is written to
GitHub: the PR is read with `gh` using GET requests only, and the review,
thread replies and check-run conclusion are printed as JSON in GitHub's
payload shape (the same shape as review-process `Claude outputs/*.json`).

## Prerequisites

- Node 22.19 or later, and `npm ci --ignore-scripts` done in this repository.
- `rg` (ripgrep) on `PATH`. It is never downloaded.
- `gh` logged in with read access to the repository.
- Your OpenRouter key in the environment as `OPENROUTER_API_KEY`. The bot
  only checks that it is set; it never reads, logs or stores it. Do not put
  it in a file in this repository.

## A cass-operator PR with the pilot knowledge

cass-operator has no `REVIEW.md` of its own yet, so the pilot's files are
given with `--knowledge-dir` and `--guidelines`. There is no default model:
pick the models for the two roles yourself.

```bash
export REVIEWER_MODEL=openrouter/<vendor>/<model>
```

```bash
export VERIFIER_MODEL=openrouter/<vendor>/<model>
```

```bash
node src/cli/main.ts review --dry-run --pr k8ssandra/cass-operator#1021 --knowledge-dir ~/projects/git/review-guidelines/pilot/cass-operator --guidelines ~/projects/git/review-guidelines/shared/go-operator-guidelines.md --model reviewer="$REVIEWER_MODEL" --model verifier="$VERIFIER_MODEL" --max-cost 3 --out "$TMPDIR/cass-operator-1021.json"
```

Any model id the provider serves works, including ones newer than pi's
offline catalog (the log then says it was used as a custom id; its context
window and output limit are borrowed from another model of the provider).
A mistyped id fails at the provider, and the run completes as *could not
complete*.

Compare the output with
`~/projects/git/review-guidelines/Claude outputs/cass-operator-1021-review.json`
(R-1 exit: comparable in form).

What happens:

- PR metadata, diff and all existing comments are read through `gh api`
  (`--method GET`, plus one GraphQL query for thread resolution).
- The base and head trees are downloaded as tarballs (`gh api
  repos/<repo>/tarball/<sha>`) and extracted under
  `$TMPDIR/review-bot-runs/run-<id>/snapshot/`. With a local clone that
  already has both commits, `--repo-dir <clone>` uses `git archive` instead.
  The runs directory must have no `.git`, `AGENTS.md` or `CLAUDE.md` above
  it (C-3a); `--runs-dir` picks another one.
- The Go module cache (`$GOMODCACHE`, else `$GOPATH/pkg/mod`, else
  `~/go/pkg/mod`) is offered read-only as the `modcache` root when it
  exists. It is only useful if it holds the versions in the PR's `go.mod`;
  `--no-modcache` turns it off. The bot never runs `go`.
- The reviewer and verifier can query history and issues: `git_log`,
  `git_blame`, `git_show` and `search_issues`, answered by review-bot
  through `gh api` (GET and one read-only GraphQL query for blame), scoped
  to the PR's repository. The model never sees a token. `--no-history`
  turns them off.
- Progress goes to stderr, one line per stage and step; the payload goes to
  stdout and to `--out`.

## Replaying an earlier head (`--head`)

To review a PR as it was before later pushes — for example to check
whether the bot would have caught what a human reviewer found (E-2: "the
head SHA at the time the comment was made"):

```bash
node src/cli/main.ts review --dry-run --pr k8ssandra/cass-operator#1021 --head <sha> --model reviewer="$REVIEWER_MODEL" --model verifier="$VERIFIER_MODEL"
```

- **Head** is `<sha>` (7 to 40 hex characters; any commit of the
  repository, including one force-pushed away; the log says when it is not
  among the PR's commits today).
- **Base** is the merge base of `<sha>` with the PR's base SHA, which is
  what GitHub diffed the PR against at that time. Knowledge files
  (`AGENTS.md`, `REVIEW.md`, guidelines, `.review/review-bot.yaml`) are read
  from that base, unless `--knowledge-dir` gives them.
- **Comments** created after the cutoff are left out. The cutoff is the
  head commit's committer date, or `--as-of <ISO 8601 time>`. GitHub keeps
  no push time on a PR; the committer date is the earliest the head could
  have been pushed, so a comment made between the commit and the push is
  left out too. If that matters, set `--as-of` to just before the comment
  you are replaying.
- **Inline comment lines:** for a comment made on this very head, its line
  is GitHub's `original_line`; for a comment made on an earlier commit the
  line at this head is not known, so it is treated like an outdated comment
  (shown to the reviewer, not used for mechanical dedupe). Thread
  resolution at that time is not known; every thread counts as open.
- **History and issue tools** stop at the cutoff too: `git_log` lists only
  commits authored by then, `search_issues` finds only issues created by
  then, and `git_show` refuses a commit committed later.
- **Not replayed:** the PR's title, description, labels and draft state
  are today's. A PR that is a draft today is skipped unless
  `--include-drafts` is given.
- The run record's `trigger` is `cli-dry-run-replay`; the head, base and
  cutoff are in the progress log.

## Output

- **stdout / `--out`:** `{ dry_run, repo, pull_number, review, thread_replies,
  resolve_threads, failure_comment?, check_run }`. `review` is the body of
  GitHub's "create a review" call, event `COMMENT`.
- **Run directory** (path printed at the end): `01-intake.json` …
  `07-publish.json` per stage, `inputs/context.md` and `inputs/patches/`
  as the reviewer saw them, and `08-record.json`, the run record (A-6) with
  every finding including dropped ones and why, per-step usage and cost,
  configured and served model IDs.
- **Exit code:** 0 reviewed or skipped, 1 could not complete (the check
  would be `neutral`), 2 usage error.

## Configuration

Flags are the workflow inputs. A `.review/review-bot.yaml` on the
repository's base branch overrides them (C-2), for example:

```yaml
roles:
  reviewer: openrouter/<vendor>/<model>
  verifier:
    model: openrouter/<vendor>/<model>
    thinking: low
    providers: [anthropic, amazon-bedrock]
    routing: { sort: price }
limits:
  reviewer: { timeoutSeconds: 1200, idleTimeoutSeconds: 180, maxTurns: 120, maxCostUsd: 3 }
  verifier: { timeoutSeconds: 480, maxTurns: 40 }
  runCostUsd: 5
  runTimeoutSeconds: 2700
  chunkPatchLines: 4000
skip:
  draft: true
  optOutLabels: [ai-review/skip]
  roundCapLabels: [round-cap]
  labels: []
  dependencies:
    labels: [deps]
    paths: [go.mod, go.sum, "vendor/**"]
```

**Skip conditions** (S-1). Each completes the check as *skipped* with the
reason in its summary and writes a run record (`result.skipKind`,
`result.skipReason`); no model is called. In order:

| Condition | Default | `skipKind` |
|---|---|---|
| No root `REVIEW.md` on the base branch | always | `not-onboarded` |
| Draft | `draft: true` (`--include-drafts` turns it off) | `draft` |
| Opt-out label | `optOutLabels: [ai-review/skip]` | `opt-out` |
| Round-cap label (set by the review-process workflow) | `roundCapLabels: [round-cap]` | `round-cap` |
| Any other label listed | `labels: []` | `label` |
| Dependency-label PR that changes only dependency files | `dependencies.labels: [deps]`; `dependencies.paths`: Go, npm, Cargo, pip/Poetry, Bundler, Maven and Gradle manifests and lock files, `vendor/**` | `deps-only` |
| This head was already reviewed | always | `already-reviewed` |

Labels match case-insensitively. A `deps`-labelled PR that also changes
anything else is reviewed in full (the log says why). Each list replaces
its default; `[]` turns a condition off.

`providers` (OpenRouter models only) restricts which upstream providers may
serve the model: it becomes OpenRouter's routing `only` with fallbacks off,
merged into any other `routing`. The same from the command line:
`--providers reviewer=anthropic,amazon-bedrock`.

Without a `verifier` model, Important findings are posted labelled
*unverified* and the summary says verification was not run.

## Per-area `REVIEW.md`

A `REVIEW.md` in a subdirectory applies to changes under that directory, in
addition to the root one (A-5). Only files above a changed path are read,
from the base branch (or from `--knowledge-dir` when given), at most 50.
The root `REVIEW.md` is still what onboards a repository.

- **Skip these paths:** every applicable file's entries apply. An area
  file's globs are relative to its directory, like a `.gitignore` in a
  subdirectory: `*.pb.go` matches at any depth below it, `/gen/` and
  `gen/x.go` are anchored at it. An area cannot un-skip what the root
  skips. The run record gives the file an exclusion came from.
- **Limits (nit cap):** the root cap counts every nit in the review; an
  area cap counts the nits anchored under that area. A nit is posted only
  when every cap that applies still has room, so the strictest wins and an
  area cannot raise the root's cap. Important findings are never capped.
- **Everything else** goes to the reviewer verbatim. `context.md` has a
  table of which `REVIEW.md` files apply to each changed file, and each
  file is labelled `applies-to` (`all files`, or `<dir>/**`).
- A PR's edit to any `REVIEW.md` is reviewed like other changes; the base
  versions apply (C-3).

## Time limits

| Limit | Default | Flag | YAML |
|---|---|---|---|
| Whole run | 45 min | `--run-timeout 30m` | `limits.runTimeoutSeconds` |
| One step, wall clock | reviewer 20 min, verifier 8 min | `--step-timeout reviewer=15m` (no role: both) | `limits.<role>.timeoutSeconds` |
| One step, no activity | 3 min | `--idle-timeout 90s` | `limits.<role>.idleTimeoutSeconds` |

Durations are `90s`, `20m`, `1.5h`; a bare number is seconds. As with every
setting, the base branch's YAML overrides the flags.

- **Step timeout and inactivity** stop the step: the model request in
  flight is aborted (not just abandoned), a running tool call is ended, and
  the step's usage is marked incomplete in the run record (aborted calls
  report no usage). The run continues with what it has.
- "Activity" is any model output or tool start or end. A provider that
  stops streaming, or a history query that hangs, trips the inactivity
  timeout. Each history or issue query also has its own 30 s limit and
  then returns an error to the model.
- **The run deadline** stops the running step the same way, starts no
  further step, and publishes what exists, labelled partial in the summary
  (for example Important findings that were not verified yet are posted as
  unverified). The check completes as `neutral`. If the deadline passes
  before any review exists, the run completes `neutral` with the
  "could not complete" comment. The run record has `deadlineReached: true`
  and the partial note.
- In CI, set the job's `timeout-minutes` a few minutes above the run
  deadline, so publishing and completing the check still fit.

## Using an ACP agent instead of OpenRouter

A role's model can be an external agent that speaks the Agent Client
Protocol: the model spec `acp/<name>` selects it, where `<name>` is defined
on the command line (never in the repository's YAML, which can only refer
to it):

```bash
node src/cli/main.ts review --dry-run --pr k8ssandra/cass-operator#1021 --acp-agent claude=claude-code-acp --model reviewer=acp/claude --model verifier=openrouter/<vendor>/<model>
```

`--acp-agent <name>=<command> [args]` splits on spaces. For arguments with
spaces, environment variables or a model choice, use `--acp-config`:

```json
{
  "agents": {
    "claude": { "command": "claude-code-acp", "args": [], "env": {}, "model": "<model id>" }
  }
}
```

The agent starts in the head snapshot, so use absolute paths for local
scripts. It needs its own credentials (environment or a prior login);
review-bot withholds GitHub tokens from it. Its isolation is weaker than the
pi step's (see `src/agent/README.md`, "ACP agents"), and spend is only
counted if the agent reports a cost.

## Offline, with the scripted model

The fixture PR used by the tests runs end to end with no network and no
key:

```bash
node src/cli/main.ts review --dry-run --fixture src/pipeline/fixtures/prs/basic --script src/pipeline/fixtures/prs/basic/script.json --no-modcache
```

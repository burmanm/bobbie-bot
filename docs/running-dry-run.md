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
- Progress goes to stderr, one line per stage and step; the payload goes to
  stdout and to `--out`.

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
  chunkPatchLines: 4000
skip:
  draft: true
  labels: [round-cap]
```

`providers` (OpenRouter models only) restricts which upstream providers may
serve the model: it becomes OpenRouter's routing `only` with fallbacks off,
merged into any other `routing`. The same from the command line:
`--providers reviewer=anthropic,amazon-bedrock`.

Without a `verifier` model, Important findings are posted labelled
*unverified* and the summary says verification was not run.

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

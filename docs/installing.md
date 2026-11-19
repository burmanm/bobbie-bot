# Installing review-bot in a repository

This page is for maintainers of a repository that adopts the automated
review (R-2). It covers the workflow file, the secrets and variables it
reads, the two identities it can post as, who gets reviewed automatically,
and what each job can and cannot do.

Design references: [C-2 to C-5](plan/06-ci-and-security.md),
[S-8, S-9](plan/03-review-pipeline.md), [A-5, A-7](plan/02-architecture.md).

## What runs

One workflow, `review-bot`, triggered by `pull_request_target` (opened,
reopened, ready for review, synchronize, labeled) and by manual dispatch with
a PR number. It has four jobs:

| Job | Runs when | Does |
|---|---|---|
| `gate` | every trigger (except label events for other labels) | Decides whether this PR is reviewed now. If not, completes the `ai-review/<name>` check as *skipped* with the reason |
| `remove-label` | the gate says the authorization label is stale | Removes it |
| `prepare` | the gate authorized a review | Downloads the base and head trees, runs `go mod download` for the head's `go.mod`, uploads both trees and the module cache as an artifact |
| `review` | after `prepare`, also when `prepare` failed | Reviews the prepared snapshot, posts one review and the check, uploads the run record. A final always-run step completes the check if the review did not |

A newer push cancels the run in flight for the same PR.

## Before you start

- The repository has a `REVIEW.md` on its default branch. Without one the
  review completes as *skipped* ("not onboarded", A-5).
- You have a model provider key (OpenRouter today, C-6) and have chosen the
  models for the `reviewer` and `verifier` roles. There is no default model.
- You have decided which identity the bot posts as (next section).

## Install the workflow

The review-process sync tool vendors `workflows/review-bot.yml` from this
repository as `.github/workflows/review-bot.yml` and sets the action
reference to a reviewed commit of this repository. By hand:

1. Copy `workflows/review-bot.yml` to `.github/workflows/review-bot.yml` on
   the default branch.
2. Replace every `REVIEW_BOT_OWNER/review-bot/action@0000000000000000000000000000000000000000`
   with `<owner>/review-bot/action@<full commit SHA>`. Always a full SHA,
   never a branch or tag.
3. Add the secrets and variables below.

`pull_request_target` always runs the workflow file from the base branch, so
a PR cannot change the workflow that reviews it.

## Secrets and variables

Secrets (repository or organization):

| Secret | Required | Used by |
|---|---|---|
| `OPENROUTER_API_KEY` | yes | the review step only |
| `REVIEW_BOT_APP_PRIVATE_KEY` | with the GitHub App identity | gate, remove-label, review (to mint a short-lived installation token) |

Variables (repository or organization; all optional except the models):

| Variable | Default | Meaning |
|---|---|---|
| `REVIEW_BOT_MODELS` | — | Role→model map, one per line: `reviewer=openrouter/<vendor>/<model>` and `verifier=openrouter/<vendor>/<model>`. Without a verifier, Important findings are posted as unverified |
| `REVIEW_BOT_THINKING` | — | One per line, `<role>=off\|minimal\|low\|medium\|high` |
| `REVIEW_BOT_PROVIDERS` | — | OpenRouter only, one per line, `<role>=<provider>,<provider>`: the upstream providers allowed to serve the model |
| `REVIEW_BOT_MAX_COST_USD` | 5 (pipeline default) | Spend cap for one run |
| `REVIEW_BOT_NAME` | `main` | Reviewer name; the check is `ai-review/<name>` |
| `REVIEW_BOT_AUTH_LABEL` | `ai-review/approved` | Authorization label (C-4) |
| `REVIEW_BOT_AUTH_LABEL_LIFETIME` | `per-push` | `per-push` or `per-pr` (Q-10) |
| `REVIEW_BOT_TIMEOUT_MINUTES` | 40 | Time limit of the review step |
| `REVIEW_BOT_JOB_TIMEOUT_MINUTES` | 50 | Time limit of the review job; keep it a few minutes above the step's so the always-run steps get to run |
| `REVIEW_BOT_PREPARE_TIMEOUT_MINUTES` | 20 | Time limit of the prepare job |
| `REVIEW_BOT_GO_VERSION` | `stable` | Go used by `go mod download`. Pin it to at least the `go` line of your `go.mod`: with `GOTOOLCHAIN=local` an older Go fails, and the review then runs without a module cache |
| `REVIEW_BOT_GO_MODULES` | `.` | Directories with a `go.mod`, space-separated |
| `REVIEW_BOT_APP_ID` | — | Set it to use the GitHub App identity |
| `REVIEW_BOT_RECORD_RETENTION_DAYS` | 90 | Retention of the run-record artifact |

Per-step limits (time, idle time, turns, cost per role), skip rules and
chunking are set in `.review/review-bot.yaml` (format in
[running-dry-run.md](running-dry-run.md#configuration)).

**`.review/review-bot.yaml` on the base branch overrides the variables**
(C-2, A-5): roles, limits, skip rules, and `authorization.label` /
`authorization.lifetime`. The reviewer name is never read from it. Two
caveats about the label:

- If the YAML sets `authorization.label`, set `REVIEW_BOT_AUTH_LABEL` to the
  same name. The workflow drops label events for other labels before any job
  starts, using the variable.
- A YAML file that does not parse is reported by the review as a
  configuration error; the gate keeps the variable's label and uses
  `per-push`, the stricter lifetime.

## Identity: `GITHUB_TOKEN` or a GitHub App

Both are supported (C-5). A personal access token is not: its comments are
not Bot-authored and it cannot create check runs.

| | `GITHUB_TOKEN` (default) | GitHub App |
|---|---|---|
| Setup | none | an App per organization, installed on the repository |
| Posts as | `github-actions[bot]` | the App's own name |
| Recognises its own comments | by hidden marker | by hidden marker |
| Check run owner | the Actions app | the App |

To use an App:

1. Create a GitHub App with repository permissions **Checks: read and
   write**, **Pull requests: read and write**, **Contents: read** and
   **Metadata: read**. No webhook, no other permission.
2. Install it on the repository.
3. Set the variable `REVIEW_BOT_APP_ID` and the secret
   `REVIEW_BOT_APP_PRIVATE_KEY`.

The workflow then mints a token per job with
[`actions/create-github-app-token`](https://github.com/actions/create-github-app-token)
(pinned by commit SHA), scoped down to that job's permissions. Without the
variable every job uses its own `GITHUB_TOKEN`.

The gate, the review and the always-run step all use the same identity,
because a check run can only be completed by the identity that created it.
If you make `ai-review/<name>` a required check, select the matching app as
its source in branch protection. The check reports whether the review *ran*
(`success`, `skipped`, `neutral`), never whether findings exist; Important
findings block merging through conversation resolution (S-7).

## Who gets an automatic review

Rules (C-4, Q-10):

- **Author with write access or above** (admin, maintain, write, checked
  through the permissions API): reviewed when the PR opens and on every push.
- **Anyone else**: the check completes as *skipped* with "a maintainer
  reviews the changes and applies the label". When someone with write access
  applies the authorization label, the PR is reviewed at the head the
  maintainer saw.
  - `per-push` (default): the next push, or reopening the PR, removes the
    label and skips; the maintainer applies it again after looking at the new
    commits.
  - `per-pr`: the label stays and every later push is reviewed.
- A label applied by someone without write access (for example the triage
  role) does not count and is removed.
- **Manual dispatch** (Actions → review-bot → Run workflow, with the PR
  number) reviews the PR's current head regardless of author; dispatching
  needs write access, and the gate checks it again.
- Bots such as Dependabot are not collaborators, so their PRs need the label.

The repository setting "Require approval for first-time contributors" does
not apply to `pull_request_target`; keep it on for your other workflows. For
this workflow the gate is the control.

## Time limits

Each job has `timeout-minutes`. The review step stops the review a minute
before its own limit, so the pipeline can complete its check and write its
record; the always-run step then completes the check as *neutral* if
anything is still open (S-9). Within the review, every model step has its own
time, idle and turn limits and the run has a spend cap.

## What you get

- The check run `ai-review/<name>` on the head commit: `success` (reviewed),
  `skipped` (not authorized, draft, opted out, not onboarded, already
  reviewed) or `neutral` (could not complete; the PR proceeds to humans).
- One review per run with event `COMMENT` (never an approval), thread
  replies on earlier findings, and resolution of its own verified-fixed
  threads.
- A workflow artifact `review-bot-record-<name>-pr<N>-<run id>-<attempt>`
  with the run record (`08-record.json`) and the stage files. It is the only
  thing the review job writes besides the PR (A-7); the harvest job collects
  it later.

## Security

The PR's content is untrusted input: its files, `go.mod`, description,
commit messages and comments. The design assumes prompt injection will
sometimes succeed against the model and makes that harmless (C-3). No job
checks out the PR, and nothing from the PR is executed anywhere.

### What each job can and cannot do

| Job | Secrets | Token permissions | Can | Cannot |
|---|---|---|---|---|
| `gate` | none with `GITHUB_TOKEN`; the App private key with the App identity | contents: read, pull-requests: read, checks: write | Read PR metadata, collaborators' permission levels, label events and `.review/review-bot.yaml` at the base SHA; create a *skipped* check | Read any PR file content other than through the API metadata above; post comments; change labels; run anything from the PR |
| `remove-label` | as `gate` | pull-requests: write | Remove the authorization label | Anything else; it runs nothing from the PR |
| `prepare` | **none**, ever (always `GITHUB_TOKEN`) | contents: read | Download the base and head trees as tarballs; run `go mod download` on a copy of the head's `go.mod` | Write to the PR, the repository, the Actions cache or any secret; build, test or `go generate` |
| `review` | the model provider key (review step only); the App private key with the App identity | pull-requests: write, checks: write | Post one review, thread replies, resolve its own threads, the check; upload the run record | Push, merge, approve, change labels, read other secrets, write to the repository or storage, run anything from the snapshot |

### The review job

- The snapshot arrives as an artifact from `prepare`. It is extracted by a
  validating extractor in a container with **no network and no
  credentials**: only files, directories and symlinks; no `..` or absolute
  paths; nothing written through a symlink; files read-only; size capped.
- The review container gets the snapshot **read-only**, runs as a non-root
  user with a read-only root filesystem, no capabilities and
  `no-new-privileges`. Its environment holds only the GitHub token and the
  provider keys named in the action's `provider-env` (never a GitHub token).
- The model never receives the GitHub token: publishing is code (P-3). Its
  tools are read-only and confined to the head, base and module-cache roots,
  with symlinks resolved; there is no shell and no network tool (C-3).
- pi runs fully isolated (C-3a): untrusted project settings, no context
  files, an empty agent directory, our extension only. The snapshot is
  extracted where no `.git`, `AGENTS.md` or `CLAUDE.md` exists in any
  parent. The repository's `AGENTS.md` reaches the model from the **base**
  branch as delimited data, never as instructions to pi.
- **No downloads at review time.** `rg` and `fd` (pi's search) and `gh` (the
  read-only history tools) are built into the action image from pinned
  release assets verified by SHA-256; `PI_OFFLINE=1` stops pi from fetching
  binaries or refreshing its model catalog. The image itself is
  built at the start of each job from the pinned action commit: base image
  pinned by digest, npm dependencies from the lockfile with
  `--ignore-scripts`, no `apt-get`.
- The PR cannot reconfigure the bot: `REVIEW.md`, `AGENTS.md`, guidelines and
  `.review/review-bot.yaml` are read from the base SHA (D-7).
- The run is pinned to what the gate authorized: `prepare` fetches the head
  SHA the gate saw, and the review refuses a snapshot whose SHAs differ from
  the PR's current head (it completes *neutral*; the newer push's own run
  reviews the new head).
- Worst case, a fully subverted model emits bad findings: they still pass
  mechanical grounding and limits and are posted as comments by an identity
  that cannot approve.

### `go mod download` on an untrusted `go.mod`

`prepare` is the only place PR-controlled input reaches a tool that acts on
it. `go mod download` does not compile or run code from the modules it
fetches, but `go.mod` decides **which** modules are fetched and from where.
The step is hardened as follows (C-4):

| Setting | Effect |
|---|---|
| `GOPROXY=https://proxy.golang.org` only (no `,direct`) | Modules come from the proxy as zip files. Direct mode would run `git`/`hg`/`svn`/`bzr` against attacker-chosen URLs, the historical code-execution route |
| `GOVCS=*:off` | The same, enforced a second way |
| `GOSUMDB=sum.golang.org`; `GONOSUMDB`, `GONOSUMCHECK`, `GOPRIVATE`, `GONOPROXY`, `GOINSECURE` empty | Every module is verified against the public checksum database |
| `GOTOOLCHAIN=local` | A `toolchain` or `go` line cannot download and run another Go |
| `GOFLAGS=-mod=readonly`, on a scratch copy | `go.mod`/`go.sum` are never rewritten, and the packed head tree is exactly what was fetched |
| `GOWORK=off` | A `go.work` in the PR is ignored |
| `env -i`, empty `HOME`, `GOAUTH=off` | No GitHub token, `.netrc` or credential helper is visible to `go` |
| `cache: false` on `setup-go`, no `actions/cache` | A `pull_request_target` job can write the base branch's cache scope; this one never does |
| Time limit and size cap | Bound bandwidth, disk and artifact size |

What remains: the PR chooses which public module versions are downloaded
(bandwidth and disk, bounded by the limits), and the runner has no
operating-system egress filter, so "network limited to the module proxy" is
enforced by `go`'s configuration, not by a firewall. The job holds no secret
and a read-only token, so there is nothing to exfiltrate. Private modules
cannot be fetched; the review then runs without a module cache and says so in
the log and the job summary.

### Known limits

- With the App identity, `gate` and `remove-label` hold the App private key
  (to mint a scoped token). Neither job runs anything from the PR. With
  `GITHUB_TOKEN` they hold no secret at all.
- The action image is built in each job from the pinned commit. Its downloads
  are pinned and verified, but they happen in the job; a prebuilt image
  pinned by digest would move them out entirely (future work).
- Labels other than the authorization label start no job and cancel
  nothing. The authorization label applied to a PR whose author already has
  write access is ignored by the gate, but it shares the PR's concurrency
  group, so it cancels a review in flight for that PR; the always-run step
  completes that check as *neutral*. Push or dispatch to review again.

## Trying it

- Run the same pipeline locally, posting nothing:
  [running-dry-run.md](running-dry-run.md).
- In the repository, open a PR as a maintainer, or dispatch the workflow
  with a PR number, and watch the `review-bot` run: the gate's job summary
  says why it reviewed or skipped, and the run-record artifact holds every
  finding, including the dropped ones and why.

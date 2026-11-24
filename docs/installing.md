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
a PR number. It has five jobs:

| Job | Runs when | Does |
|---|---|---|
| `gate` | every trigger (except label events for other labels) | Decides whether this PR is reviewed now. If not, completes the `ai-review/<name>` check as *skipped* with the reason |
| `remove-label` | the gate says the authorization label is stale | Removes it |
| `prepare` | the gate authorized a review | Downloads the base and head trees, runs `go mod download` for the head's `go.mod`, uploads both trees and the module cache as an artifact |
| `setup` | the gate authorized a review and `REVIEW_BOT_AGENT_DIR` is set | Installs the packages the [agent directory](#the-agent-directory) lists, with lifecycle scripts off, in a job with no secret and no token permissions; hands the result to `review` as an artifact |
| `review` | after `prepare` and `setup`, also when either failed | Reviews the prepared snapshot as the pi command `/review-bot`, posts one review and the check, uploads the run record. A final always-run step completes the check if the review did not |

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

Variables (repository or organization; all optional except the models). An
unset variable leaves the agent directory's `settings.json` in effect (F-7):

| Variable | Default | Meaning |
|---|---|---|
| `REVIEW_BOT_AGENT_DIR` | — | The operator's pi agent directory, a path in this repository (`settings.json` with `reviewBot` and `enabledModels`, `models.json`). Read from the **default branch's** head, never from a PR |
| `REVIEW_BOT_AGENT_DIR_REPO` | — | Take `REVIEW_BOT_AGENT_DIR` from an organization configuration repository instead: `owner/name@<40-hex commit SHA>`. The gate's token must be able to read it |
| `REVIEW_BOT_MODELS` | — | Role→model map, one per line: `reviewer=openrouter/<vendor>/<model>` and `verifier=openrouter/<vendor>/<model>`. Without a verifier, Important findings are posted as unverified |
| `REVIEW_BOT_THINKING` | — | One per line, `<role>=off\|minimal\|low\|medium\|high\|xhigh\|max` |
| `REVIEW_BOT_PROVIDERS` | — | OpenRouter only, one per line, `<role>=<provider>,<provider>`: the upstream providers allowed to serve the model |
| `REVIEW_BOT_MAX_COST_USD` | 5 (pipeline default) | Spend cap for one run |
| `REVIEW_BOT_NAME` | `main` | Reviewer name; the check is `ai-review/<name>` |
| `REVIEW_BOT_AUTH_LABEL` | `ai-review/approved` | Authorization label (C-4) |
| `REVIEW_BOT_AUTH_LABEL_LIFETIME` | `per-push` | `per-push` or `per-pr` (Q-10) |
| `REVIEW_BOT_TIMEOUT_MINUTES` | 40 | Time limit of the review step. The run deadline is capped three minutes inside it; a lower `runTimeoutSeconds` in settings or the YAML applies |
| `REVIEW_BOT_JOB_TIMEOUT_MINUTES` | 50 | Time limit of the review job; keep it a few minutes above the step's so the always-run steps get to run |
| `REVIEW_BOT_PREPARE_TIMEOUT_MINUTES` | 20 | Time limit of the prepare job |
| `REVIEW_BOT_AGENT_DIR` | — | The [agent directory](#the-agent-directory): a directory in this repository, read from the default branch's head |
| `REVIEW_BOT_AGENT_DIR_REPO` | — | Take `REVIEW_BOT_AGENT_DIR` from another repository at a pinned commit instead: `owner/name@<40-hex SHA>` |
| `REVIEW_BOT_SETUP_TIMEOUT_MINUTES` | 15 | Time limit of the setup job |
| `REVIEW_BOT_GO_VERSION` | `stable` | Go used by `go mod download`. Pin it to at least the `go` line of your `go.mod`: with `GOTOOLCHAIN=local` an older Go fails, and the review then runs without a module cache |
| `REVIEW_BOT_GO_MODULES` | `.` | Directories with a `go.mod`, space-separated |
| `REVIEW_BOT_APP_ID` | — | Set it to use the GitHub App identity |
| `REVIEW_BOT_RECORD_RETENTION_DAYS` | 90 | Retention of the run-record artifact |
| `REVIEW_BOT_CI_REQUIRE` | `off` | Wait for CI before reviewing ([below](#waiting-for-ci)): `off`, `required`, or names, comma-separated |
| `REVIEW_BOT_CI_ON_FAILURE` | `skip` | `skip` or `review` when required CI failed |
| `REVIEW_BOT_CI_TIMEOUT` | `6h` | How long a PR waits for CI |
| `REVIEW_BOT_IMAGE` | the digest in `action/image.lock` | The action image ([below](#the-action-image)): `build`, or `<registry>/<name>@sha256:<digest>` |
| `REVIEW_BOT_NO_HISTORY` | — | `true`: no history or issue tools ([private repositories](#private-repositories)) |
| `REVIEW_BOT_HISTORY_READ` | — | `true`: the App token of the review job also requests `contents: read` and `issues: read` ([private repositories](#private-repositories)) |

Per-step limits, roles, tools and skip rules are set in the agent
directory's `settings.json` under `reviewBot`; the base branch's
`.review/review-bot.yaml` can narrow them (format in
[running-dry-run.md](running-dry-run.md#configuration)).

**`.review/review-bot.yaml` on the base branch can only lower limits**
(F-7): a higher one, for example `runCostUsd` above
`REVIEW_BOT_MAX_COST_USD` or `runTimeoutSeconds` above the review step's
deadline (2220 by default), completes the check *neutral* without a review.
It can pick a model only from `enabledModels` in `settings.json`. It does
replace the variables (C-2, A-5) for skip rules, `authorization.label` /
`authorization.lifetime`, and `ci.require` / `ci.onFailure` / `ci.timeout`. The reviewer name is never read from it. Two
caveats about the label:

- If the YAML or `settings.json` sets `authorization.label`, set
  `REVIEW_BOT_AUTH_LABEL` to the same name. The workflow drops label events for other labels before any job
  starts, using the variable.
- A YAML file that does not parse is reported by the review as a
  configuration error; the gate keeps the variable's label and uses
  `per-push`, the stricter lifetime.

## The agent directory

The bot is configured as any pi module is (F-7): a pi agent directory, the
same one you can point `pi` at locally. Put it in a directory on the
default branch (for example `.github/review-bot/`) and set
`REVIEW_BOT_AGENT_DIR` to that path, or keep it in an organization
configuration repository and also set `REVIEW_BOT_AGENT_DIR_REPO` to
`owner/name@<commit SHA>`. It is never read from the PR, neither its head
nor its base (D-19): packages run code and `models.json` can run a command.
The gate fetches it through the API; a change takes effect when it is
merged.

`settings.json`:

```json
{
  "packages": [
    "npm:@org/pi-provider-x@1.2.3",
    "git:github.com/org/pi-tool@<40-hex commit>"
  ],
  "enabledModels": ["openrouter/vendor/*"],
  "codemode": { "mode": "on" },
  "reviewBot": {
    "roles": {
      "reviewer": { "model": "openrouter/vendor/model:high", "tools": ["+codemode"] },
      "verifier": { "model": "openrouter/vendor/other" }
    },
    "limits": { "runCostUsd": 5 }
  }
}
```

| Key | Meaning |
|---|---|
| `packages` | pi packages loaded into the model steps, pinned: `npm:<name>@<exact version>`, `git:<host>/<path>@<commit SHA>` (https only), or `./node_modules/<name>` from a `package.json` and lockfile next to `settings.json`. Ranges, branches and paths outside the directory are refused |
| `enabledModels` | Models `.review/review-bot.yaml` may pick for a role. Without it the YAML cannot change a model |
| `codemode` | pi's own settings for its built-in `codemode` tool (`mode`: `on` or `only`; `inlineBudget`) |
| `reviewBot.roles.<role>.model` | `provider/id[:thinking]`, as pi's `--model` takes it. The `REVIEW_BOT_MODELS` variable replaces it |
| `reviewBot.roles.<role>.tools` | Changes to the role's read-only default, in pi's `defaultTools` syntax: `"+codemode"` enables codemode for that role, `"+<tool>"` a tool from a listed package, `"-<tool>"` removes one |
| `reviewBot.codemode.models` | `true` lets codemode scripts call `models.*` (default `false`) |
| `reviewBot.limits`, `skip`, `ci`, `authorization` | As in `.review/review-bot.yaml`, which can only narrow them |

`models.json` (optional) holds custom providers and endpoints, extra model
ids and `modelOverrides` (prices, context), in pi's format. Keys come from
environment variables, `"apiKey": "$NAME"`; add the variable's name to the
action's `provider-env` and the secret to the review step's `env`.

An `AGENTS.md`, `SYSTEM.md` or `APPEND_SYSTEM.md` in the directory is
refused. The workflow variables override `settings.json`, and the base
branch's `.review/review-bot.yaml` can only narrow both.

Check it locally: `PI_CODING_AGENT_DIR=<dir> pi --list-models` shows what
the bot can use, and `/review-bot --dry-run --pr <owner/repo#N>` in that pi
runs the same review, posting nothing.

**Packages are installed before any secret is present.** The `setup` job
downloads the gate's copy of the directory, runs `review-bot setup` in the
action image with network but no GitHub token, no provider key and no token
permissions, with lifecycle scripts off (npm and git configuration that
names programs is pinned too), and uploads the installed directory as an
archive. The review job unpacks it with the snapshot's validating extractor
in a container without network, mounts it read-only and checks every listed
package before anything loads; a missing one is a configuration error. The
review job downloads nothing. Only listed packages load; a dependency that
happens to be a pi package does not.

**A module is code with the model key and the GitHub token.** It runs in
the review job and can do anything pi allows: add tools, replace the bot's
tools, change prompts and responses through hooks (F-7). A module that gives
the model a shell, network access or an unconfined file reader also gives it
to whoever writes the PR, through prompt injection. The defaults have none.
Review a package's source as you would any dependency, pin it, and treat
adding or upgrading one as a change to replay (E-5). The run record lists
every loaded package and version, and the review summary lists the extra
tools that were active.

**Codemode.** With `"+codemode"` in a role's `tools`, the model can write a
script that calls that role's other tools in pi's sandbox (no file system,
network or process access); path checks apply to calls from scripts too,
and their usage counts toward the spend cap. `codemode: false` in
`.review/review-bot.yaml` turns it off for the repository. Every script a
run executes is saved, secrets scrubbed, as `scripts.json` next to the run
record (below).

## Identity: `GITHUB_TOKEN` or a GitHub App

Both are supported (C-5). A personal access token is not: its comments are
not Bot-authored and it cannot create check runs.

| | `GITHUB_TOKEN` (default) | GitHub App |
|---|---|---|
| Setup | none | an App per organization, installed on the repository |
| Posts as | `github-actions[bot]` | the App's own name |
| Recognises its own comments | by hidden marker and the review ID on its check run | by hidden marker and the review ID on its check run |
| Check run owner | the Actions app | the App |

To use an App:

1. Create a GitHub App with repository permissions **Checks: read and
   write**, **Pull requests: read and write**, **Contents: read**,
   **Commit statuses: read**, **Actions: read** and **Metadata: read**. No
   webhook, no other permission. (The gate requests the two CI reads on
   every run, for [waiting for CI](#waiting-for-ci); a token request for a
   permission the App lacks fails.) On a private repository that wants the
   history tools, also **Issues: read**.
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

## Waiting for CI

Optional, per repository (C-9): the bot does not review a head commit until
the repository's own CI has passed on it. Set it in
`.review/review-bot.yaml` on the base branch (or with `reviewBot.ci` in
`settings.json` or the `REVIEW_BOT_CI_*` variables, which the YAML
replaces):

```yaml
ci:
  require: required        # off | required | [build, "ci/jenkins", Tests]
  onFailure: skip          # skip | review
  timeout: 6h
```

- `required` means the base branch's required status checks (branch
  protection and rulesets) minus every `ai-review/*` check. A list may name
  check runs (job names), commit-status contexts or workflow names.
- After authorization the gate looks at those checks on the head commit:
  all passed (`success`, `skipped`, `neutral`) → review; one failed →
  `skip` completes `ai-review/<name>` as *skipped*, "CI failed: <names>",
  and `review` reviews anyway and says so in the summary; any pending or not
  yet reported → `ai-review/<name>` is created **queued**, "Waiting for CI:
  <names>", and nothing else runs (no prepare, no model).
- A waiting PR is resumed by `workflow_run` (any workflow but this one
  completing for a PR head), `status` (CI reporting commit statuses from
  outside Actions) and a sweep every 30 minutes. They run from the default
  branch, find the PR by listing open PRs whose head is the commit (fork PRs
  are not named in these events), check authorization again, and claim the
  check (set it in progress) before reviewing, so two runs never review the
  same commit.
- The sweep completes a check queued longer than `ci.timeout` as *skipped*,
  "CI did not report within <timeout>" (for example a first-time
  contributor's CI run awaiting approval), and a check left in progress for
  4 hours as *neutral*. A new push completes the previous commit's queued
  check as *skipped*, "Superseded by a newer push". A queued check therefore
  always ends as *success*, *skipped* or *neutral* (I-2 #1).
- Dispatching the workflow by hand has an `ignore-ci` box to review without
  waiting.
- The run record stores when the head commit was first seen, when CI
  completed and what resumed the review (`run.waiting`, A-6).

Cost when unused: every CI workflow completion for a PR head or push and
every non-pending commit status starts a short `review-bot` run whose gate
finds nothing waiting, and the sweep runs every 30 minutes. A repository
that never waits for CI can delete the `workflow_run`, `status` and
`schedule` triggers from its copy of the workflow; a repository that does
can narrow `workflow_run.workflows` to its CI workflow names (it must never
match `review-bot` itself).

## Private repositories

The reviewer's history tools (`git_log`, `git_blame`, `git_show`) and issue
search call the GitHub API with the review job's token (C-4). On a private
repository that token also needs **`contents: read`** and **`issues:
read`**. Neither lets the job write anything. Choose one:

- Grant them: in your copy of the workflow, uncomment the two lines under
  the review job's `permissions:`; with the App identity, also give the App
  **Contents: read** and **Issues: read** and set the variable
  `REVIEW_BOT_HISTORY_READ` to `true`, so the review job's token requests
  them.
- Or set `REVIEW_BOT_NO_HISTORY` to `true`: the reviewer works without those
  tools and the summary says issue search was not available.

On a public repository nothing is needed.

## The action image

The `gate`, `setup`, `review`, `complete-check` and `remove-label` steps
run in a container. By default it is the **prebuilt image named by digest in
`action/image.lock`** of the pinned action commit (C-4): the job pulls that
one image, Docker verifies it against the digest, and nothing else is
downloaded in the job that holds the model key. While `action/image.lock`
names no digest, or with `REVIEW_BOT_IMAGE=build`, the image is built in the
job from `action/Dockerfile` instead (pinned and checksum-verified
downloads, but downloads). A tag that is not a digest is refused.

Publishing (maintainers of this repository):

1. Run the `action-image` workflow (`.github/workflows/action-image.yml`) on
   the default branch at the commit to release. It builds amd64 and arm64
   images without cache, pushes `ghcr.io/<owner>/review-bot-action` with
   BuildKit provenance and an SBOM, adds a GitHub artifact attestation, and
   prints the line for `action/image.lock`.
2. Commit that line to `action/image.lock` and change nothing else the image
   contains (`src/`, `pi-review/`, `package*.json`, `action/Dockerfile`,
   `action/tools.json`, `action/install-tools.mjs`, `action/debs.json`,
   `action/fetch-debs.mjs`): the image *is* the bot's code, so any such
   change needs a new image.
3. Make the package public (or readable by the consuming organizations) and
   pin consumers to that commit.
4. Anyone can check it: `gh attestation verify
   oci://ghcr.io/<owner>/review-bot-action@sha256:<digest> --owner <owner>`.

The image has `git` for the setup job's git package sources: Debian packages
from `snapshot.debian.org` URLs pinned with their SHA-256 in
`action/debs.json`, installed with `dpkg` (no `apt-get`); git's CA bundle is
Node's built-in root certificates. To update them, run
`action/update-debs.sh [<snapshot timestamp>]` (Docker and network), which
checks each file against Debian's signed index, and publish a new image.

## Time limits

Each job has `timeout-minutes`. The review step stops the review a minute
before its own limit, so the pipeline can complete its check and write its
record; the always-run step then completes the check as *neutral* if
anything is still open (S-9). Within the review, every model step has its own
time, idle and turn limits and the run has a spend cap.

## What you get

- The check run `ai-review/<name>` on the head commit: `success` (reviewed),
  `skipped` (not authorized, draft, opted out, not onboarded, already
  reviewed, CI failed, CI did not report, superseded) or `neutral` (could
  not complete; the PR proceeds to humans). While waiting for CI it is
  `queued`.
- One review per run with event `COMMENT` (never an approval), thread
  replies on earlier findings, and resolution of its own verified-fixed
  threads.
- A workflow artifact `review-bot-record-<name>-pr<N>-<run id>-<attempt>`
  with the run record (`08-record.json`), the stage files and, when a role
  ran codemode, `scripts.json`: each script's source (secrets scrubbed,
  size capped), outcome and nested tool calls, enough to replay it against
  the head SHA in the record. Scripts can quote PR code. It is the only
  thing the review job writes besides the PR (A-7); the harvest job collects
  it later.
- When the gate completes the check itself (not authorized, CI failed or
  timed out, superseded by a push, or a review that died long ago), a
  workflow artifact `review-bot-record-<name>-gate-<run id>-<attempt>` with
  one run record per check it completed. Its `run.result.skipKind` says
  which, and it has no model steps.

## Security

The PR's content is untrusted input: its files, `go.mod`, description,
commit messages and comments. The design assumes prompt injection will
sometimes succeed against the model and makes that harmless (C-3). No job
checks out the PR, and nothing from the PR is executed anywhere.

### What each job can and cannot do

| Job | Secrets | Token permissions | Can | Cannot |
|---|---|---|---|---|
| `gate` | none with `GITHUB_TOKEN`; the App private key with the App identity | contents: read, pull-requests: read, checks: write, statuses: read, actions: read | Read PR metadata, collaborators' permission levels, label events, `.review/review-bot.yaml` at the base SHA, and the CI results of the head commit; create a *skipped* or *queued* check, and complete a queued one | Read any PR file content other than through the API metadata above; post comments; change labels; run anything from the PR |
| `remove-label` | as `gate` | pull-requests: write | Remove the authorization label | Anything else; it runs nothing from the PR |
| `prepare` | **none**, ever (always `GITHUB_TOKEN`) | contents: read | Download the base and head trees as tarballs; run `go mod download` on a copy of the head's `go.mod` | Write to the PR, the repository, the Actions cache or any secret; build, test or `go generate` |
| `setup` | **none**, and no token | none | Download the packages the agent directory lists (registries, git hosts) with lifecycle scripts off; upload the result | Read the PR or anything from it; post anything; run install scripts |
| `review` | the model provider key (review step only); the App private key with the App identity | pull-requests: write, checks: write; on private repositories with the history tools also contents: read, issues: read | Post one review, thread replies, resolve its own threads, the check; upload the run record | Push, merge, approve, change labels, read other secrets, write to the repository or storage, run anything from the snapshot |

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
- pi runs isolated (C-3a), started by `review-bot launch` as the command
  `/review-bot` (`-ne -e <pi-review>`, `--no-approve`, `--offline`, stdin
  closed) from an empty working directory: untrusted project settings, no
  context files, the operator's agent directory (or an empty one) and only
  the packages it lists. The snapshot is
  extracted where no `.git`, `AGENTS.md` or `CLAUDE.md` exists in any
  parent. The repository's `AGENTS.md` reaches the model from the **base**
  branch as delimited data, never as instructions to pi.
- **No downloads at review time.** The operator's packages come from the
  `setup` job. `rg` and `fd` (pi's search) and `gh` (the read-only history
  tools) are built into the action image from pinned release assets verified
  by SHA-256; `PI_OFFLINE=1` stops pi from fetching
  binaries or refreshing its model catalog. The image itself is the
  prebuilt one pinned by digest in the action commit
  ([above](#the-action-image)); without one, it is built at the start of
  each job: base image pinned by digest, npm dependencies from the lockfile
  with `--ignore-scripts`, no `apt-get`.
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
- Install the agent directory's packages with `review-bot setup --agent-dir
  <dir>` in a step that has no secrets (exit 0 installed, 1 an installer
  failed, 2 usage, 3 configuration). Step 6 adds it to the workflow. A role's
  `tools` can then name tools those packages provide. A package that replaces
  one of the bot's tools is recorded in the run record and listed in the
  review summary. A replacement that reads an argument other than `path` is
  not confined.
- Codemode is enabled per role with `"+codemode"` in the agent directory's
  `reviewBot.roles.<role>.tools`; the base branch's YAML can only turn it
  off. Scripts' tool calls pass the same checks as the model's, and the
  executed scripts are saved to `scripts.json` next to the run record.
  `reviewBot.codemode.models: true` gives scripts pi's `models` API, which is
  not limited to `enabledModels`; leave it off unless you need it.
- An agent directory containing `AGENTS.md`, `SYSTEM.md` or
  `APPEND_SYSTEM.md`, or overlapping a read root, is refused.
- The runner must start the real `node` binary for `review-bot launch`
  (R-1a step 6 switches the action to it). A version-manager shim such as
  Volta's does not pass SIGTERM on, and a cancelled review then publishes
  nothing.
- A package listed in the agent directory's `settings.json` that is not
  installed stops the review as a configuration error (exit 1).
- Until `action/image.lock` names a published digest, the action image is
  built in each job: its downloads are pinned and verified, but they happen
  in the job.
- Waiting for CI trusts check names. A fork PR's own `pull_request`
  workflow can create a check run with any job name, including a required
  one, and so make the bot review before the real CI finished (it cannot
  make the bot do anything else; authorization is checked separately). The
  expected app of a required check is not compared.
- A cancelled or timed-out review job (SIGTERM reaches pi through the
  container's init and `review-bot launch`) completes its check as
  *neutral* and writes the run record, but does not post the findings it
  already had. The run's own deadline, a few minutes inside the step's
  limit, does post a partial review.
- A module that leaves a timer or file watcher running would keep pi alive
  after the run; the command ends the process 5 seconds after the run is
  published (seen with a real package).
- When two open PRs share a head commit, a CI result resumes one of them;
  the other is resumed by the next sweep.
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

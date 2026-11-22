# 06 — CI operation and security

## C-1 — Requirements for unattended operation

- No prompt ever waits for a human. Extension code guards any UI call with
  `ctx.hasUI`; in the runner there is no UI at all.
- All configuration comes from workflow inputs and repository files. All
  output goes to the PR, the check run, the run directory, and logs.
- Bounded: every model step and the whole run have time and spend limits.
- Idempotent: re-running a job for the same head SHA posts nothing new.
- The `ai-review/<name>` check run is always completed
  ([S-9](03-review-pipeline.md#s-9--failure-behaviour)).

## C-2 — Workflows

| Workflow | Trigger | Job |
|---|---|---|
| Review | `pull_request_target`: opened, reopened, ready for review, synchronize, labeled; manual dispatch with PR number; when waiting for CI also `workflow_run` completed, `status`, and a schedule ([C-9](#c-9--waiting-for-ci)) | gate → prepare → setup, then pi `/review-bot` |
| Harvest | Schedule; PR closed | `review-bot harvest` |
| Learn | Schedule; manual | `review-bot learn` → report issue, PRs |
| Eval | Manual; on PRs to the bot's own repository | `review-bot eval` |

- One trigger for every PR, fork or not, so there is a single code path.
  The workflow file is always the base branch's.
- Concurrency group per PR with cancel-in-progress.
- Delivered as a GitHub Action in this repository, pinned by consumers to a
  commit SHA. The consuming workflow file is a shared file vendored by the
  review-process sync tool; nothing references another organization at run
  time other than the pinned action itself.
- Configuration: a pi agent directory supplied by the operator (providers,
  models, modules, and the bot's settings under `reviewBot`), overridden by
  workflow inputs and narrowed by `.review/review-bot.yaml` on the base
  branch. See [F-7](01-foundation-pi.md#f-7--configuration-follows-pi).
- The same command runs locally (`/review-bot` inside pi, dry-run unless
  told otherwise) and prints the would-be review. That is both the
  development loop and the "local review step" of the review process.

## C-3 — Trust model

The PR's content is **untrusted input**: diff, files, description, commit
messages, comments. The design assumes prompt injection will sometimes
succeed against the reviewer and makes that outcome harmless with the
default tools.

**The line is a merge** ([D-19](README.md#key-decisions)). Nothing from a PR
is executed or becomes configuration without one. What maintainers merged
(workflow, agent directory, modules) is trusted. Out of scope: a maintainer
merging a harmful module or setting, and people with write access, who can
already reach repository secrets from a branch workflow.

Rules that hold whatever the operator configures:

| Rule | Mechanism |
|---|---|
| The job holding secrets never checks out or executes PR code | Two-job split ([C-4](#c-4--fork-pull-requests-and-authorization)). The review job receives the PR tree as an extracted archive, mounted read-only |
| Nothing from the PR is executed | No install, build, test or probe in the review job. pi and every session run in an empty working directory, so neither a module nor a program it starts (git, a formatter) picks up commands from the PR's files ([C-3a](#c-3a--pi-session-isolation)) |
| The PR cannot load code into pi | **The pi SDK trusts the project by default**, so isolation is explicit ([C-3a](#c-3a--pi-session-isolation)). Only our extension, pi's built-ins and the operator's listed modules load |
| The PR cannot reconfigure the bot | The agent directory comes from the default branch or a pinned organization repository. `AGENTS.md`, `REVIEW.md`, vendored guidelines and `.review/review-bot.yaml` are read from the **base** SHA ([D-7](README.md#key-decisions)), and the YAML can only narrow models and limits. A PR that edits them is reviewed under the old versions, and the summary says so |

Rules that hold with the default tools, codemode included. A module can give
them up, and merging it is the maintainers' decision
([F-7](01-foundation-pi.md#f-7--configuration-follows-pi)):

| Rule | Mechanism |
|---|---|
| The model cannot act on GitHub | No tool exposes the GitHub token or writes to GitHub. Publishing is code |
| The model cannot change anything | The default tools are read-only; the extension's `tool_call` guard rejects any tool not configured for the role |
| The model cannot read outside the snapshots | pi does **not** confine its read tools: they accept absolute paths, `..` and `~`. The same guard resolves the path argument of `read`, `grep`, `find` and `ls` (following symlinks), also for calls made by other tools, and rejects anything outside the allowed roots: head, base, module cache, inputs. This is the only barrier between the model and the runner's filesystem |
| The model cannot exfiltrate | No network tools, no shell. The GitHub token and provider key are in the runner process, and no tool returns them. Codemode's sandbox has no process, file system or network |
| The PR cannot hide anything from the reviewer | The search tools ignore `.gitignore`, `.ignore` and similar files in the snapshot (pi's own `find` and `grep` honour them, so ours replace or wrap them). What is skipped comes only from `REVIEW.md` on the base branch. A PR's changes to ignore files, and to the knowledge files above, are in the diff and reviewed like any other change |
| Worst case is bounded | A fully subverted reviewer can only emit findings. Those pass mechanical grounding and limits, and are posted as comments by a bot that cannot approve |

Untrusted text sits in clearly delimited sections of `context.md`, with
delimiter look-alikes neutralized. That is hygiene; the table is the
defence.

## C-3a — pi session isolation

Verified in the R-0 spike ([findings §1, §5, §9](spike-r0-findings.md)). A
plain `createAgentSession({ cwd: snapshot })` executes the snapshot's
`.pi/extensions`, applies its `.pi/settings.json` and `.pi/SYSTEM.md`, and
puts its `AGENTS.md` in the system prompt. Every model step is therefore
created with **all** of:

| Setting | Keeps out |
|---|---|
| Working directory: an empty directory the bot owns, outside every read root, for the parent pi and every session. The bot's tools resolve relative paths against head | Configuration that modules and the programs they start discover from the working directory: tool config files with commands, an embedded bare git repository |
| `safe.bareRepository=explicit` in git's environment | An embedded bare repository in the snapshot, when something runs git inside it anyway |
| Settings with `projectTrusted: false`; the parent pi runs with `--no-approve` | The snapshot's `.pi/` settings, extensions, skills, prompts, themes, system-prompt files; the user-level settings file |
| A private agent directory: empty, or the operator's configuration ([F-7](01-foundation-pi.md#f-7--configuration-follows-pi)) and nothing else | The runner user's `~/.pi/agent`: extensions, `auth.json`, `models.json`, global `AGENTS.md`. The operator directory must contain no `AGENTS.md`, `SYSTEM.md` or `APPEND_SYSTEM.md`; the step checks |
| Resource loader with no discovered extensions, skills, prompt templates or themes; our extension and pi's built-ins (inactive) passed explicitly, plus only the packages listed in the operator's `settings.json` | Everything discovered |
| `noContextFiles` | `AGENTS.md` / `CLAUDE.md`. This is a **separate switch from project trust**, and pi walks from the working directory up to the filesystem root. The base branch's `AGENTS.md` reaches the model through `context.md` instead |
| Our own system prompt | pi's coding-assistant preamble |
| In-memory session manager | Session files |
| Explicit tool list: the role's configured set | Every tool not named, for the model and for tools that call tools |

Three further requirements:

- **Where the snapshot is extracted.** Outside any directory that has a
  `.git` entry, or an `AGENTS.md` / `CLAUDE.md`, in itself or any parent.
- **No downloads in the job that holds secrets.** pi's `grep` and `find`
  need the `rg` and `fd` binaries and download them from GitHub at first use
  if they are missing. The action image ships both, and `PI_OFFLINE=1` is
  set.
- **A regression test is mandatory.** One missing option silently restores
  the unsafe default. The bot's test suite plants hostile `.pi/` files, an
  `AGENTS.md`, an escaping symlink, out-of-root paths and a `.gitignore`
  that hides a file in a snapshot, and asserts that none load, none are
  readable, and the hidden file is still found by search. It also plants a
  working-directory config with a command and an embedded bare repository,
  and runs with fixture modules and codemode enabled. It runs on every pi
  upgrade.

Isolation stops *loading*. The planted files remain ordinary files in the
PR that the model can read as untrusted data, like any other.

## C-4 — Fork pull requests and authorization

Fork PRs are the normal path for the target repositories, maintainers
included, so this is the main design, not a special case.

**Three jobs, plus a small label job:**

| Job | Secrets | Token | Does |
|---|---|---|---|
| `gate` | none (App identity: the App private key) | `contents: read`, `pull-requests: read`, `checks: write`, `statuses: read`, `actions: read` | Decides whether this PR is reviewed automatically. If not, completes `ai-review/<name>` as *skipped*. `contents: read` is only for the agent directory's `settings.json` on the default branch and `.review/review-bot.yaml` at the base SHA ([A-5](02-architecture.md#a-5--knowledge-sources)). `statuses: read` and `actions: read` are only for the CI state of the head SHA ([C-9](#c-9--waiting-for-ci): commit statuses, and workflow runs when `ci.require` names a workflow); the workflow cannot request them only when waiting is configured |
| `remove-label` | none (App identity: the App private key) | `pull-requests: write` | Removes the authorization label on the contributor's next push when its lifetime is *per push* ([Q-10](07-roadmap.md#open-questions)). Separate because the gate's token is read-only. Reads nothing from the PR |
| `prepare` | **none** | `contents: read` | Fetches base and head trees. Runs the language preparation step (Go: `go mod download` for the head's `go.mod`). Uploads snapshots and module cache as an artifact |
| `review` | model provider key (App identity: also the App private key) | `pull-requests: write`, `checks: write`; on private repositories also `contents: read` (agent directory, history) and `issues: read` (below) | Fetches the agent directory from the default branch, then installs its packages in a step with no secrets in its environment and lifecycle scripts off. Downloads the artifact, extracts it as read-only data to a directory with no `.git` or context files above it, runs `/review-bot` from an empty working directory with `PI_OFFLINE=1`. **Never** checks out the PR, never runs `go`, `make` or anything from the snapshot, never downloads a binary |

**Identity in every job.** With the App identity, each job that talks to
GitHub mints its own token from the App private key, scoped to that job's
permissions in the table. The key is therefore present in `gate`,
`remove-label` and `review`. None of them executes PR content, and in
`review` only the token minted from it enters the container; the key does
not. With the default tools that token is out of the model's reach too
([C-3](#c-3--trust-model)). The job that
creates the check run and the jobs that complete it must use the same
identity: GitHub lets only the creator update a check run.

**Private repositories.** The reviewer's history tools (`git_log`,
`git_blame`, `git_show`) and issue search ([S-4](03-review-pipeline.md#s-4--review))
call the GitHub API with the review job's token. On a public repository
that works with the permissions above. On a private one the token also
needs `contents: read` and `issues: read`; with the App identity the App
needs the same permissions and the minted token must request them. Neither
permission lets the job write anything. `contents: read` is also how the
job reads the agent directory there, so it is required on a private
repository that keeps that directory itself. A repository that does not
grant `issues: read` runs with `--no-history`, and the summary says the
tools were not available.

**The action image.** The review container is built in each job from a
Dockerfile whose downloads (Node by digest, `rg`, `fd`, `gh`) are pinned
and checksum-verified. That still means network downloads in the job that
holds the model key. A prebuilt image pinned by digest removes them and is
the intended next step ([R-2](07-roadmap.md#r-2--live-on-the-pilot)).

`prepare` is the only place PR-controlled input reaches a tool that acts on
it, so it is hardened even though it has nothing worth stealing:
`GOTOOLCHAIN=local` (a `toolchain` line cannot pull and run another Go),
`GOFLAGS=-mod=readonly`, fixed `GOPROXY`/`GOSUMDB`, no `go generate`, no
build, **no cache writes** (a `pull_request_target` job can write to the
base branch's cache scope, which is a poisoning route). If preparation
fails, the review still runs without a module cache and says so.

This satisfies the review process's rule for privileged jobs — never check
out or execute PR code — literally.

**Who gets an automatic review:**

- Author has write access to the repository (checked through the
  permissions API, which is more reliable than `author_association` when
  organization membership is private) → reviewed automatically on open and
  on each push.
- Anyone else → reviewed only after a maintainer applies the authorization
  label. Both the label name and its lifetime are configurable. Default
  name `ai-review/approved`; default lifetime *per push* — the label is
  removed on the author's next push, so approval covers the commits the
  maintainer looked at. The alternative, *per PR*, keeps it.
- Label events count only when applied by someone with write access.
- GitHub's "require approval for first-time contributors" setting stays on.

Outside contributors' PRs always get a human look regardless (RP §8); the
automatic review is a help to the maintainer, not a replacement.

## C-5 — Credentials and identity

Both identities are supported ([Q-1](07-roadmap.md#open-questions) —
decided):

| | GitHub App | Actions `GITHUB_TOKEN` |
|---|---|---|
| Review, comments, check runs | yes | yes |
| Posts as a Bot-type author (state workflow needs this) | yes, own name | yes, as `github-actions[bot]` |
| Recognising own comments | by marker | by marker (the login is shared with other workflows) |
| Learn job opening PRs | yes, and CI runs on them | Only if the repository allows Actions to create PRs; CI does **not** run on PRs it opens. Otherwise the learn job stays report-only |
| Setup | App per organization | none |

A personal access token of a user account is **not** supported: its
comments are not Bot-authored, which breaks the state workflow's thread
counting, and it cannot create check runs.

Permissions: review job `pull-requests: write`, `checks: write`; harvest
`pull-requests: read`, `actions: read`, plus write access to the store;
learn `contents: write` restricted to `agent/*` branches, `pull-requests:
write`, `issues: write`. Provider keys are organization or repository
secrets passed by environment to the runner only.

## C-6 — Model provider

First deployment uses **OpenRouter**, which pi supports natively
(`OPENROUTER_API_KEY`); no extra package is needed. Nothing in the bot is
OpenRouter-specific.

- **Models change often** — new models, and new releases of the same model.
  The role→model map is therefore plain configuration (`reviewBot.roles`,
  or a workflow input that overrides it and can read an organization or
  repository variable), never code, and
  changing it needs no bot release.
- **Providers are pi configuration.** Another provider, a gateway, an
  endpoint or a pi provider package is added in the operator's pi agent
  directory (`models.json`, `settings.json` `packages`), in pi's format,
  with no change to the bot ([F-7](01-foundation-pi.md#f-7--configuration-follows-pi)).
  OpenRouter upstream restrictions use pi's `compat.openRouterRouting`.
- **Owners decide what is allowed**, per organization, and enforce it at the
  provider: an OpenRouter API key can be restricted to specific models, and
  upstream-provider and data-retention preferences are set there. The bot
  treats a refused model as a configuration error and completes its check
  as *neutral* with that reason.
- **The run record stores the model ID the provider actually served**, not
  only the configured name, because an alias can start pointing at a newer
  release without any change on our side. That makes a behaviour shift
  traceable to a model change.
- A change of model is checked by replay before rollout
  ([E-5](05-evaluation.md#e-5--acceptance-procedure)); a silent upstream
  change shows up afterwards in the outcome shares.

## C-7 — Privacy and data handling

- Run records hold findings and metadata, not source, but may quote code in
  evidence and in saved scripts ([A-6](02-architecture.md#a-6--run-record)).
  Store access follows the repository's.
- Records from private organizations stay within that organization
  ([A-7](02-architecture.md#a-7--store)).
- A secret detected in a diff is reported without echoing its value.

## C-8 — Observability

- Structured log line per stage with duration and outcome.
- Job summary: findings by status, cost, per-step timings.
- Run record artifact on every run, including failures.
- A heartbeat line while a model step is working.
- Production metrics — cost, findings, rounds, human comments, missed
  findings, timings — are computed by the harvest job, not by the review
  job ([10-metrics.md](10-metrics.md)).

## C-9 — Waiting for CI

Optional, per repository: the bot does not review a head SHA until the
repository's own CI has passed on it. A red build usually means another
push is coming, and a review of a broken change costs the same as a review
of a good one ([D-16](README.md#key-decisions)).

**Configuration** (bot settings, [F-7](01-foundation-pi.md#f-7--configuration-follows-pi)):

| Key | Values | Default |
|---|---|---|
| `ci.require` | `off`; `required` (the base branch's required status checks, minus every `ai-review/*` check); or a list of check-run, status-context or workflow names | `off` |
| `ci.onFailure` | `skip` (complete the check as *skipped*, "CI failed: <names>") or `review` (review anyway, and say so in the summary) | `skip` |
| `ci.timeout` | How long to wait for CI before giving up | `6h` |

**In the gate job** (no secrets, no model), after authorization:

| State of the required checks on the head SHA | Gate does |
|---|---|
| All completed, conclusion `success`, `skipped` or `neutral` | Continue to prepare and review |
| Any completed with another conclusion | `ci.onFailure` |
| Any pending or not yet reported | Create `ai-review/<name>` as **queued** with "Waiting for CI: <names>", and stop. No prepare, no model call |

**Triggers that re-run the gate** for a waiting PR (added to the review
workflow, [C-2](#c-2--workflows)):

- `workflow_run` with `types: [completed]`, naming the repository's CI
  workflows. GitHub does not start workflows on `check_suite` events from
  suites that Actions created, so `check_suite` cannot be used for this.
  `workflow_run` runs the default branch's workflow file with secrets, like
  `pull_request_target`; it gets the same three-job split. Its
  `pull_requests` field is empty for fork PRs, so the PR is found by
  listing open PRs and matching `head.sha`. An event for a SHA that is no
  longer the PR's head is ignored.
- `status` for CI that reports commit statuses from outside Actions.
- A schedule (every 30 minutes) that completes a check queued longer than
  `ci.timeout` as *skipped*, "CI did not report within <timeout>", so no
  PR stays in `review/bots` forever when CI never starts (for example a
  first-time contributor's run awaiting approval).
- Manual dispatch with the PR number, by someone with write access, which
  can also pass `--ignore-ci`.

A new push while waiting is handled like any push: the concurrency group
cancels the old gate, and the new head SHA gets its own check.

The run record stores when the head SHA was first seen and when CI
completed, so the CI wait is visible in the metrics
([O-1](10-metrics.md#o-1--what-is-measured)).

**Contract.** I-2 #1 still holds: a queued check always ends as
*success*, *skipped* or *neutral* — by review, by CI failure, or by
timeout. Whether a PR whose CI failed should move on to people at all is
the review-process state workflow's call, not the bot's
([I-5](09-process-integration.md#i-5--gaps-this-exposes-in-review-process-to-raise-there)).

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
| Review | `pull_request_target`: opened, reopened, ready for review, synchronize, labeled; manual dispatch with PR number | gate → prepare → `review-bot review` |
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
- Configuration: workflow inputs first (reviewer name, role→model map,
  limits, authorization label), optionally overridden by
  `.review/review-bot.yaml` on the base branch.
- The same CLI runs locally (`review-bot review --pr N --dry-run`, or
  `/review` inside pi on a working tree) and prints the would-be review.
  That is both the development loop and the "local review step" of the
  review process.

## C-3 — Trust model

The PR's content is **untrusted input**: diff, files, description, commit
messages, comments. The design assumes prompt injection will sometimes
succeed against the reviewer and makes that outcome harmless.

| Rule | Mechanism |
|---|---|
| The job holding secrets never checks out or executes PR code | Two-job split ([C-4](#c-4--fork-pull-requests-and-authorization)). The review job receives the PR tree as an extracted archive and only reads it |
| The model cannot act on GitHub | Model steps never receive the GitHub token. Publishing is code |
| The model cannot change anything | Tool allowlist is read-only; the extension's `tool_call` guard rejects everything else |
| The model cannot read outside the snapshots | pi does **not** confine its read tools: they accept absolute paths, `..` and `~`. The same guard resolves every path argument (following symlinks) and rejects anything outside the allowed roots — head, base, module cache. This is the only barrier between the model and the runner's filesystem |
| The model cannot exfiltrate | No network tools, no shell. The provider key is held by the runner process, not exposed to tools |
| Nothing from the PR is executed | No install, build, test or probe in the review job |
| The PR cannot reconfigure the bot | `AGENTS.md`, `REVIEW.md`, vendored guidelines and `.review/review-bot.yaml` are read from the **base** SHA ([D-7](README.md#key-decisions)). A PR that edits them is reviewed under the old versions, and the summary says so |
| The PR cannot hide anything from the reviewer | The search tools ignore `.gitignore`, `.ignore` and similar files in the snapshot (pi's own `find` and `grep` honour them, so ours replace or wrap them). What is skipped comes only from `REVIEW.md` on the base branch. A PR's changes to ignore files, and to the knowledge files above, are in the diff and reviewed like any other change |
| The PR cannot load code into pi | **The pi SDK trusts the project by default**, so isolation is explicit ([C-3a](#c-3a--pi-session-isolation)). Our extension is the only one loaded |
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
| In-memory settings with `projectTrusted: false` | The snapshot's `.pi/` settings, extensions, skills, prompts, themes, system-prompt files; the user-level settings file |
| A private, empty agent directory | User-level extensions, `auth.json`, `models.json`, global `AGENTS.md` |
| Resource loader with no discovered extensions, skills, prompt templates or themes; our extension passed explicitly | Everything discovered |
| `noContextFiles` | `AGENTS.md` / `CLAUDE.md`. This is a **separate switch from project trust**, and pi walks from the working directory up to the filesystem root. The base branch's `AGENTS.md` reaches the model through `context.md` instead |
| Our own system prompt | pi's coding-assistant preamble |
| In-memory session manager | Session files |
| Explicit tool list | Every tool not named |

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
  readable, and the hidden file is still found by search. It runs on every pi
  upgrade.

Isolation stops *loading*. The planted files remain ordinary files in the
PR that the model can read as untrusted data, like any other.

## C-4 — Fork pull requests and authorization

Fork PRs are the normal path for the target repositories, maintainers
included, so this is the main design, not a special case.

**Three jobs:**

| Job | Secrets | Token | Does |
|---|---|---|---|
| `gate` | none | `pull-requests: read`, `checks: write` | Decides whether this PR is reviewed automatically. If not, completes `ai-review/<name>` as *skipped* |
| `prepare` | **none** | `contents: read` | Fetches base and head trees. Runs the language preparation step (Go: `go mod download` for the head's `go.mod`). Uploads snapshots and module cache as an artifact |
| `review` | model provider key | `pull-requests: write`, `checks: write` | Downloads the artifact, extracts it as read-only data to a directory with no `.git` or context files above it, runs the pipeline with `PI_OFFLINE=1`. **Never** checks out the PR, never runs `go`, `make` or anything from the snapshot, never downloads a binary |

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
  The role→model map is therefore plain configuration (workflow input,
  which can read an organization or repository variable), never code, and
  changing it needs no bot release.
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
  evidence. Store access follows the repository's.
- Records from private organizations stay within that organization
  ([A-7](02-architecture.md#a-7--store)).
- A secret detected in a diff is reported without echoing its value.

## C-8 — Observability

- Structured log line per stage with duration and outcome.
- Job summary: findings by status, cost, per-step timings.
- Run record artifact on every run, including failures.
- A heartbeat line while a model step is working.

# R-1a proposal: the bot as a pi module, any pi module inside it

Status: **accepted and applied to the plan, 2026-11-22; not implemented.** Kept
for the evidence. Where it differs from the numbered plan files, those win.
"Tested" means probed on macOS with pi 1.5.2, offline, with fake models and fake
secrets. "Read" means taken from source or pi's docs only.

## Decided by the owner

| Topic | Decision |
|---|---|
| Trust | What maintainers merged is trusted: workflow, agent directory, modules. The line to hold is that **a PR gets nothing executed or configured without a merge** |
| Token | No host/child split. Modules share the process with the GitHub token and model key |
| Module power | Anything goes: an operator's module may replace any tool, the prompt and the outputs |
| Shape | The whole bot is a pi module, if no behaviour is lost |
| Codemode | Enable it, and save the scripts if that stays simple (it does). Evaluation is later work |

Out of scope: a maintainer merging a harmful module or setting, and people with
write access, who can already reach repository secrets from a branch workflow.

## The line: nothing from a PR without a merge

| Path from a PR | Finding | Rule | Basis |
|---|---|---|---|
| **The working directory** | Sessions run with cwd = PR head. An honest module that reads `<cwd>/.tool.json` takes its configuration, commands included, from the PR | **cwd is an empty directory the bot owns**, for pi and every session. The bot's tools resolve relative paths against head | Tested |
| **git inside the snapshot** | A PR can commit an embedded bare repository. It survived `git archive` and our extractor, and `git status` there ran the PR's command | The same cwd rule, plus `safe.bareRepository=explicit` in the environment | Tested, with the mitigation |
| Project trust | A module's `project_trust` handler loaded the PR's `.pi` extension | `--no-approve` and the same cwd rule | Tested |
| Agent directory | It can name packages and commands | Read from the default branch or a pinned organization repository, never the PR head or base | Design |
| `.review/review-bot.yaml` | Comes from the base branch, which need not be the default one. Today it can raise every limit and choose any model | It may only narrow | Read |
| Package sources | A local path could point into the snapshot | Must resolve outside every read root. Installed in a step without secrets | Design |
| Codemode scripts | An injected script tried the filesystem, `/proc`, `process`, `fetch` and the model catalogue: no fake secret came out | Keep path checks on nested calls | Tested |

The first two are not exploitable in today's action: it loads no modules and the
image has no git. They become exploitable with "any module".

What this cannot cover: a merged module that gives the model a shell, network
access or an unconfined reader also gives it to whoever writes the PR, through
prompt injection. Enabling one is the maintainers' decision. The defaults have
none, the installing guide says this in one paragraph, and the summary lists the
extra tools that were active.

## Behaviour as a module, without a host

D-2 keeps its SDK session per step. Only the entry point changes, to a pi
command. Tested: the existing pipeline completed a fixture review as a command,
and codemode worked in a session created by one.

| Problem with a bare `pi -p /command` | Fix | Basis |
|---|---|---|
| A throwing handler exits 0 | The command sets the exit code. The workflow's existing `complete-check` step also turns an unfinished check neutral after exit 0 | Tested |
| An absent command is sent to the model, exit 0 | Load by path, `-e <bot>`: a missing path exits 1 | Tested |
| A name collision has the same effect | `-ne` in the parent and the name `/review-bot`. Packages load in role sessions | Tested |
| SIGTERM skips publishing and the record | Await the pipeline in `session_shutdown` | Tested |
| `console.log` goes to stderr | Write the result with `--out` | Tested |
| Malformed `settings.json` is only a warning | The command validates it first | Tested |
| A missing package is skipped offline | The command checks each listed package | Tested |
| pi waits while stdin is open | Start it with stdin closed | Tested |
| Gate jobs need no pi | `gate`, `prepare` and `complete-check` stay plain CLI | Read |

## Configuration

The operator's `settings.json`. pi keeps unknown keys when it rewrites the file
and extensions can read them (tested), which answers Q-20.

```json
{
  "packages": ["npm:@org/pi-x@1.2.3"],
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

- `tools` uses pi's `defaultTools` syntax, relative to the role's read-only
  default. pi's own default (which has `bash`) is never inherited.
- Providers and routing move to `models.json`. The `thinking`, `providers` and
  `routing` fields go away.
- A module may replace a tool. The replacement is in the run record. Path checks
  stay on the names `read`, `grep`, `find` and `ls`, whoever implements them.

## Codemode

| Today | Change | Basis |
|---|---|---|
| The guard rejects `codemode` and every nested call | Allow configured tools, nested or not | Tested |
| SDK sessions lack pi's built-in extensions | Register codemode, tool search and MCP, inactive | Read |
| Cost counts only assistant messages, so nested usage escapes the spend cap | Add tool-result usage to accounting | Read |
| Scripts have no default deadline | Step and idle timeouts are the bound | Read |

### Saved scripts

pi's events already carry the exact source and each nested call with its
parent's id (tested), so this is a subscriber and one file:

- `scripts.json` next to the run record. The workflow's existing artifact glob
  (`runs/*/*.json`) uploads it with the same retention.
- Per script: step, call id, source, outcome, and nested calls as tool name and
  error flag. Findings reported from inside a script keep its id.
- No script output and no tool results. With the head SHA from the record that
  is enough to replay.
- A size cap, and `scrubSecrets` over the source. Its pattern misses `ghs_`
  tokens that contain `_` or `.` (tested with a synthetic one); widen it here.
- Scripts can quote PR code, so A-6's "no file contents" gets this exception.

## Work, in order

Each step is one change that passes typecheck and tests.

| # | Step | Done when |
|---|---|---|
| 1 | Neutral cwd for sessions | The isolation test plants a cwd config and an embedded bare repository and neither takes effect. Relative paths still resolve in head |
| 2 | Configuration: `reviewBot`, `models.json`, model suffix, narrowing-only YAML | A `models.json` endpoint works with no code change. YAML cannot raise a limit |
| 3 | `pi-review` becomes a package with `/review-bot` | Fixture output through pi equals the CLI's. Every row of the module table has a test |
| 4 | Package setup and loading, per-role tools | Provider, tool, hook and tool-replacing fixture packages work. The hostile-PR test passes with them loaded |
| 5 | Codemode, nested accounting, saved scripts | An injected script gets no canary. Nested cost hits the cap. `scripts.json` replays a script |
| 6 | Workflow, action, installing guide, plan edits | One dry run on a cass-operator PR with codemode on and off |

Step 4 must not ship before step 1.

Exit for R-1a: a provider package, a tool-replacing package and codemode are each
enabled by editing only the agent directory, the same directory works for
`/review-bot` in pi, and the hostile-PR test passes with all three enabled.

The existing exit criterion's `/review` does not exist yet (`pi-review/` has no
manifest and registers no command). Step 3 creates it.

## Plan edits made on acceptance

- D-2: SDK per step, started from a pi command.
- C-3, C-3a, D-15: the line above, the neutral cwd, configured extensions.
- P-3: "never see write credentials" holds for the model with the default tools,
  not for modules.
- D-4: guaranteed unless an operator's module replaces the output tools.
- D-18, F-7: any module, with the bot's settings in `settings.json`.
- A-6: `scripts.json`. Q-20: closed.
- R-6: evaluate saved scripts as check candidates.

## Not verified

- Linux, Docker, and the action end to end.
- A real model using codemode, and whether it improves reviews or cost.
- A real third-party package or MCP server.
- Nested-usage accounting (found by reading, not reproduced).

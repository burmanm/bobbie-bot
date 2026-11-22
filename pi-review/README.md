# pi-review (package `review-bot-pi-command`)

review-bot as a pi package (F-3, A-8). Not the official `pi-review`
package; the name in `package.json` is `review-bot-pi-command` so the two
cannot be confused.

| Path | What | May import (A-2) |
|---|---|---|
| `command/` | The `/review-bot` command: runs the same review as `review-bot review`, with the same options (`src/cli/review.ts`) | everything |
| `extension/` | Tools and guard loaded into each role session by the pipeline | `core` |
| `skills/review-method/` | The method (S-4) | — |
| `prompts/` | Step prompts | — |

The package works from this repository's checkout: the command imports
`../src` and its dependencies resolve from the repository's `node_modules`.

## Running it

In CI, and wherever the result matters, start it through the launcher,
which starts pi the way F-3's table requires (`-ne -e <pi-review>`,
`--no-approve`, `--offline`, stdin closed, an empty working directory) and
returns the command's exit code:

```sh
review-bot launch --dry-run --fixture src/pipeline/fixtures/prs/basic \
  --script src/pipeline/fixtures/prs/basic/script.json --no-modcache --out review.json
```

Interactively, in a pi started with `pi -e ./pi-review`:

```
/review-bot --fixture src/pipeline/fixtures/prs/basic --script src/pipeline/fixtures/prs/basic/script.json --out review.json
```

The interactive command is a dry run unless `--live` is given; in print
mode (`pi -p`) it posts unless `--dry-run` is given, as the CLI does. The
result JSON is written only to `--out`. Without `--agent-dir`, the
configuration is pi's own agent directory (F-7).

Send the launcher's own process the signal, not a shell shim in front of
it: a version-manager shim (Volta's `node`, for example) may not pass
SIGTERM on, and then nothing is published.

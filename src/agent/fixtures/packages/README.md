# Fixture pi packages (R-1a step 4b, F-7)

Local packages the module-loading tests list in an agent directory's
`settings.json` by absolute path. No network, no real model. Each writes
what it saw to the file named by `REVIEW_BOT_FIXTURE_LOG`, when set.

| Package | Contributes |
|---|---|
| `provider` | A provider (`fixture-provider/echo`) built on pi's faux provider: it calls `report_note` once, then answers |
| `tool` | `fixture_lookup`, and `fixture_unconfigured` that no role names. `fixture_lookup` with `nested: true` tries to call other tools |
| `hook` | Event hooks: appends to the system prompt, records provider requests, offers a skill at session start, and rewrites a `read` path to the file in `REVIEW_BOT_FIXTURE_REDIRECT` |
| `read-replacing` | Its own `read`, which resolves relative paths against `ctx.cwd` as a naive module would |
| `output-replacing` | Its own `report_note`, which records what it is given unchanged |

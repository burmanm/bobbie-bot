# agent

Runs one model step (A-2). `createPiSdkAgentStep()` returns an `AgentStep`
backed by the pi SDK; the guard and tools it loads live in
`pi-review/extension/`.

| File | What |
|---|---|
| `types.ts` | `AgentStep`, request and result types |
| `pi-sdk-step.ts` | The pi SDK implementation: isolation (C-3a), limits (F-3), usage (A-6) |
| `accounting.ts` | Usage sums and the turn and spend caps, pure |
| `testing.ts` | Hostile snapshot fixture and scripted-model helpers, tests only |
| `isolation.test.ts` | The mandatory isolation regression test (C-3a). Run it on every pi upgrade |

## Changes from the interface proposed in spike-r0-findings.md

- **Output tools are definitions, not names.** `outputTools` takes
  `{ name, description, parameters, validate? }` (`OutputTool`, defined in
  `pi-review/extension/output-tools.ts`). `core` supplies the schemas;
  nothing here knows the Finding type. Request and result are generic over
  the tools, so `outputs[i].value` has the schema's static type.
- **`rejectedCalls` entries carry `toolCallId` and `kind`**
  (`guard`, `not-allowed`, `schema`, `validator`), so A-6 can count guard
  blocks and schema violations separately.
- **`stoppedBy`** says which limit ended a `timeout` or `truncated` step:
  `turns`, `cost`, `timeout`, `idle`, `output-length`, `cancelled`.
- **`usage.usageComplete`** is false when a model call was aborted in
  flight (A-6, Q-16). A turn or spend cap ends the run between calls, so it
  leaves usage complete; a timeout or cancellation during a call does not.
- **`toolCalls: { total, failed }`** counts every tool call.
- **`harness`** also lists the loaded extensions and the declared tools,
  for the run record. `name` is only `"pi-sdk"`: tests use the same
  implementation with pi's scripted provider, so there is no separate
  scripted step.
- **`ModelRef.routing`** is accepted only for `openrouter`; for any other
  provider it is a configuration error rather than silently dropped.
- **`roots.inputs`** (added for the pipeline): a run-directory folder with
  `context.md` and `patches/` (S-0, S-3). Readable like the other roots, but
  not an evidence root.
- The read roots are appended to the system prompt in a `<read_roots>`
  section with their absolute paths, since `base` and `modcache` are reached
  by absolute path.

## Behaviour worth knowing

- **Model ids missing from pi's offline catalog** (C-6: models change
  faster than pi releases) are used as custom ids, as pi's own CLI does:
  transport settings come from another model of the same provider, the price
  table is zeroed (no estimate from another model's prices; OpenRouter still
  reports its billed cost), and the result has `uncataloguedModel: true`. A
  wrong id fails at the provider as a `provider` error. An unknown provider
  is still a configuration error.
- **Configuration errors** (unknown provider, missing root, no credentials,
  missing `rg`, bad limits or tool names) return `outcome: "error"` with
  `error.kind: "config"` before any model call.
- **Isolation is checked on the live session** before the first call: the
  project must not be trusted, our extension must be the only one, and the
  active tools must equal the allowlist. Otherwise the step fails with an
  `internal` error. Several isolation options overlap, so losing one would
  not always change what the model sees; this check catches it.
- **Process environment.** Every step sets `PI_OFFLINE=1`,
  `PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0` and points
  `PI_CODING_AGENT_DIR` at a private empty directory created once per
  process. Each step also gets its own empty agent directory, removed after
  the step.
- **API key.** Read by pi from the provider's environment variable
  (`OPENROUTER_API_KEY`). The step only asks pi whether credentials are
  configured; it never reads or logs the key.
- **Search tools need `rg`, not `fd`.** `find` lists files with
  `rg --files`, so `fd` is never needed. Without `rg` on `PATH`, a step that
  allows `grep` or `find` fails as a configuration error; nothing is
  downloaded.
- **Turn and spend caps** are enforced in pi-agent-core's `finishTurn` hook
  (`session.agent.finishTurn`, chained after pi's own), which ends the run
  before the next request. A model that has finished is never cut off by a
  cap. Timeouts and cancellation call `session.abort()`.

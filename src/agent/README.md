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
| `acp/acp-step.ts` | `AgentStep` over the Agent Client Protocol: the step runs in an external agent |
| `acp/connection.ts` | Minimal ACP client: JSON-RPC 2.0, one message per line, over the agent's stdio |
| `acp/outputs.ts` | Output tools described in the prompt; the agent's JSON block checked like tool calls |
| `acp/fake-agent.ts` | Scripted ACP agent, tests only |
| `request-summary.ts` | Summary of each provider request body for the run record (A-6) |
| `limits.ts` | `RUN_DEADLINE`: the abort reason that stops a step as a run-deadline timeout |
| `timeouts.test.ts` | Step timeout, inactivity, run deadline, hung provider, hung tool call, query tools |
| `routed-step.ts` | Sends `acp/<agent>` models to the ACP step, everything else to pi |
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
  `turns`, `cost`, `timeout`, `idle`, `deadline`, `output-length`,
  `cancelled`. `deadline` is the run deadline: the pipeline aborts the
  run signal with `RUN_DEADLINE` as the reason, and the step ends as
  `timeout` rather than `cancelled`, so the run can still publish.
- **`queryTools`** (R-2): read-only queries the orchestrator answers
  (history, issue search; S-4). Definitions like output tools
  (`QueryTool`, `pi-review/extension/query-tools.ts`): schema, `validate`,
  and `run(value, signal) => text`. The extension caps the answer size,
  bounds each call (`timeoutMs`, default 30 s), and settles the call as
  soon as the step is stopped even if `run` ignores its signal. The ACP
  step does not offer them (the agent cannot call our tools); its
  `harness.tools` does not list them.
- **`providerRequests`** (R-2): one summary per request sent to the
  provider (model, message count, tool names, max tokens, reasoning and
  routing settings, body size and sha256; never message text or the key),
  from pi's `before_provider_request` event. pi fires it for real providers:
  every pi-ai API implementation calls `options.onPayload(params, model)`
  just before sending, and the SDK routes `onPayload` to the extension
  runner. The faux provider never calls `onPayload`, so it is empty in the
  scripted tests (`request-summary.test.ts` wraps the faux provider to call
  it, as `openai-completions` does). Empty for ACP agents.
- **`abandoned`** is set when a stopped step did not settle within
  `abortGraceMs` (a provider or tool that ignores the abort). The step
  returns anyway, with `usageComplete: false`.
- **`usage.usageComplete`** is false when a model call was aborted in
  flight (A-6, Q-16). A turn or spend cap ends the run between calls, so it
  leaves usage complete; a timeout or cancellation during a call does not.
- **`toolCalls: { total, failed }`** counts every tool call.
- **`harness`** also lists the loaded extensions and the declared tools,
  for the run record. `name` is only `"pi-sdk"`: tests use the same
  implementation with pi's scripted provider, so there is no separate
  scripted step.
- **`ModelRef.routing`** is accepted only for `openrouter`; for any other
  provider it is a configuration error rather than silently dropped. The
  pipeline's `providers` list becomes routing `only` with
  `allow_fallbacks: false`.
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
  cap. Timeouts and cancellation call `session.abort()`, which aborts the
  provider request in flight (the request's signal; checked in
  `timeouts.test.ts`) and any running tool. If pi does not settle within
  `abortGraceMs` (default 10 s), the step returns `abandoned`.

## ACP agents

A model `acp/<name>` runs the step in an external agent that speaks the
[Agent Client Protocol](https://agentclientprotocol.com) (for example an
ACP adapter for Claude Code, Codex or Gemini CLI). The operator defines the
agent (`--acp-agent`, `--acp-config`); `.review/review-bot.yaml` can only
pick one by name, never give a command. One agent process and one ACP
session per step, started in the head snapshot.

How it differs from the pi step:

- **Isolation is weaker than C-3a.** The agent brings its own system
  prompt, tools and configuration, which we cannot inspect. The client
  offers only `fs/read_text_file` (confined to the read roots, same
  `AllowedRoots` as the pi tools), no terminal and no writes, answers
  permission requests with allow only for `read`, `search` and `think`
  tools (paths inside the roots), and starts the agent without
  `GITHUB_TOKEN`, `GH_TOKEN` and the Actions tokens. Anything the agent does
  without asking is outside our control: run it only where that is
  acceptable.
- **Outputs** are described in the prompt (name, description, JSON
  Schema); the agent ends with a json block of calls, which are checked
  against the schema and `validate` like pi tool calls. Rejected calls are
  sent back for one correction round (`maxCorrections`). A step stopped by a
  limit has no outputs.
- **System prompt** goes at the top of the first prompt in
  `<instructions>`; ACP has no system prompt.
- **Turns:** each prompt round and each tool call the agent reports counts
  as one; `maxTurns` cancels the session when exceeded.
- **Usage:** tokens from the prompt response's `usage` and cost from
  `usage_update` (USD), only if the agent sends them. Otherwise cost is 0
  and `usageComplete` is false, so the run spend cap cannot see the step.
  `costIsBilled` is always false.
- **servedModels** is the agent's current model id if it reports one
  (`session/new` → `models`), else `acp/<name>`. `model` in the agent
  config is selected with `session/set_model`.
- **Errors:** an agent that cannot start, needs authentication or speaks
  another protocol version is a `config` error; one that exits or answers
  with an error is a `provider` error. Timeouts, idle, turns and
  cancellation send `session/cancel`; an agent that does not answer within
  the grace period is killed.

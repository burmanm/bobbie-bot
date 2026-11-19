/**
 * The step the pipeline uses: models `acp/<agent>` run in an external agent
 * over ACP, every other provider runs in our pi session.
 */
import { ACP_PROVIDER } from "./acp/acp-step.ts";
import type { AgentStep } from "./types.ts";

export function createRoutedAgentStep(steps: { pi: AgentStep; acp?: AgentStep }): AgentStep {
  return {
    run: async (request) => {
      if (request.model.provider !== ACP_PROVIDER) return steps.pi.run(request);
      if (steps.acp !== undefined) return steps.acp.run(request);
      return {
        outcome: "error",
        error: { kind: "config", message: `model "${ACP_PROVIDER}/${request.model.id}" needs an ACP agent, and none is configured (--acp-agent)` },
        outputs: [],
        rejectedCalls: [],
        toolCalls: { total: 0, failed: 0 },
        usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, costIsBilled: false, usageComplete: true, wallMs: 0 },
        servedModels: [],
        providerRequests: [],
        harness: { name: "acp", version: "unknown", extensions: [], tools: [] },
      };
    },
  };
}

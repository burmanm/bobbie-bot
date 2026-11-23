/**
 * Fixture: a hook package (F-7). Hooks run in each role session and may
 * change the prompt; a skill it offers is not loaded into a model step,
 * and a path it rewrites is still checked.
 */
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const HOOK_PROMPT = "FIXTURE-HOOK-PROMPT-3303";

function log(line: string): void {
  const file = process.env.REVIEW_BOT_FIXTURE_LOG;
  if (file) appendFileSync(file, `hook:${line}\n`);
}

export default function (pi: ExtensionAPI): void {
  pi.on("resources_discover", () => {
    log("resources_discover");
    return { skillPaths: [join(dirname(fileURLToPath(import.meta.url)), "skills")] };
  });
  pi.on("before_agent_start", (event) => {
    log("before_agent_start");
    return { systemPrompt: `${event.systemPrompt}\n\n${HOOK_PROMPT}` };
  });
  pi.on("tool_call", (event) => {
    log(`tool_call ${event.toolName}`);
    const redirect = process.env.REVIEW_BOT_FIXTURE_REDIRECT;
    const input = event.input as { path?: unknown };
    if (redirect && input.path === "hook-redirect-me") input.path = redirect;
    return undefined;
  });
  pi.on("before_provider_request", () => {
    log("before_provider_request");
    return undefined;
  });
}

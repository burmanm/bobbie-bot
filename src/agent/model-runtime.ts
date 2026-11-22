/**
 * pi's model runtime as the bot builds it (F-7, C-3a): pi's catalog plus
 * the operator's `models.json`, nothing else.
 *
 * - `models.json` is read from the operator's agent directory (F-7): custom
 *   providers and endpoints, extra ids, `modelOverrides`,
 *   `compat.openRouterRouting`. Without an agent directory, none is read.
 * - Credentials are held in memory: keys come from the environment (C-5) or
 *   from `"apiKey"` in `models.json`; no `auth.json` is read or written,
 *   neither the operator's nor `~/.pi/agent`'s.
 * - The refreshed-catalog cache is in memory too. pi would otherwise write
 *   `models-store.json` next to `models.json`, into the operator's directory.
 * - `PI_OFFLINE=1`: no catalog download (C-3a).
 */
import { join } from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const MODELS_FILE = "models.json";

type NativeProvider = Parameters<ModelRuntime["registerNativeProvider"]>[0];

export interface ModelRuntimeOptions {
  /** The operator's agent directory (F-7). Absent: pi's built-in catalog only. */
  agentDir?: string;
  /** Extra providers registered on the runtime (tests: pi's scripted provider). */
  providers?: readonly NativeProvider[];
}

/** `models.json` could not be used. The message never quotes the file, which may hold keys. */
export class ModelsFileError extends Error {
  override name = "ModelsFileError";
}

export async function createModelRuntime(options: ModelRuntimeOptions = {}): Promise<ModelRuntime> {
  process.env.PI_OFFLINE = "1";
  const modelsPath = options.agentDir === undefined ? null : join(options.agentDir, MODELS_FILE);
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath,
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
  });
  const error = runtime.getError();
  if (error !== undefined) {
    // pi's message can carry the JSON parser's excerpt of the file; keep only its kind.
    const kind = /^(Failed to load|Failed to parse|Invalid) models\.json( schema)?/.exec(error)?.[0] ?? "Cannot use models.json";
    throw new ModelsFileError(`${kind} in the agent directory (${modelsPath}); run \`pi --list-models\` with PI_CODING_AGENT_DIR set to it for details`);
  }
  for (const provider of options.providers ?? []) runtime.registerNativeProvider(provider);
  return runtime;
}

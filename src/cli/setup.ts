/**
 * `review-bot setup` (F-7, C-4, R-1a step 4b): installs the packages listed
 * in the operator's agent directory, with lifecycle scripts off, in a step
 * that holds no secrets. The review then runs offline and only checks them.
 *
 * Exit codes:
 *   0  installed and verified; the list is printed as JSON on stdout
 *   1  an installer failed or timed out (a retry may help)
 *   2  usage error
 *   3  configuration error: fix settings.json or the agent directory
 *   130, 143  stopped by SIGINT or SIGTERM; the running installer was killed
 */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { ConfigError, parseDuration, readAgentSettings } from "../pipeline/agent-settings.ts";
import type { Io } from "./review.ts";

export const SETUP_USAGE = `
  review-bot setup --agent-dir <dir> [--read-root <dir> ...] [--timeout <duration>]

    Installs the packages listed in <dir>/settings.json (npm:, git: and the
    package.json + lockfile next to it) with lifecycle scripts off, then
    checks them as the review will. Run it in a step without secrets.
    --read-root   A directory the review will read (snapshot, module cache,
                  runs directory). Nothing may be installed into or loaded
                  from one. Repeatable.
    --timeout     Per installer command, e.g. 5m (default 5m).
    Exit codes: 0 installed, 1 installer failed, 2 usage, 3 configuration
    error, 130/143 stopped by a signal.
`;

export const SETUP_EXIT = { ok: 0, installFailed: 1, usage: 2, config: 3 } as const;

export interface SetupEntry {
  signal?: AbortSignal;
  /** Which signal stopped the command, for the exit code. */
  stoppedBy?: () => NodeJS.Signals | undefined;
  /** Where installers' allowlisted variables come from. Default: process.env. */
  env?: NodeJS.ProcessEnv;
  /** Tests only: replaces the real npm, pnpm and git. */
  run?: import("../setup/index.ts").CommandRunner;
}

export async function runSetupCommand(argv: readonly string[], io: Io, entry: SetupEntry = {}): Promise<number> {
  let values: { "agent-dir"?: string; "read-root"?: string[]; timeout?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        "agent-dir": { type: "string" },
        "read-root": { type: "string", multiple: true },
        timeout: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    io.stderr(`${e instanceof Error ? e.message : String(e)}\n${SETUP_USAGE}`);
    return SETUP_EXIT.usage;
  }
  if (values.help) {
    io.stdout(SETUP_USAGE);
    return SETUP_EXIT.ok;
  }
  if (values["agent-dir"] === undefined) {
    io.stderr(`--agent-dir is required\n${SETUP_USAGE}`);
    return SETUP_EXIT.usage;
  }
  const timeoutMs = values.timeout === undefined ? undefined : parseDuration(values.timeout);
  if (values.timeout !== undefined && !(timeoutMs !== undefined && timeoutMs > 0)) {
    io.stderr(`invalid --timeout ${values.timeout}\n${SETUP_USAGE}`);
    return SETUP_EXIT.usage;
  }
  const agentDir = resolve(values["agent-dir"]);
  const forbiddenRoots = (values["read-root"] ?? []).map((r) => resolve(r));

  const { PackageInstallError, SetupCancelledError, SetupConfigError, setupPackages } = await import("../setup/index.ts");
  try {
    const settings = readAgentSettings(agentDir);
    const installed = await setupPackages({
      agentDir,
      packages: settings.packages,
      forbiddenRoots,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(entry.env === undefined ? {} : { env: entry.env }),
      ...(entry.run === undefined ? {} : { run: entry.run }),
      ...(entry.signal === undefined ? {} : { signal: entry.signal }),
    });
    for (const p of installed) io.stderr(`[review-bot] installed ${p.name}${p.version === undefined ? "" : `@${p.version}`} (${p.source})\n`);
    io.stdout(`${JSON.stringify(installed, null, 2)}\n`);
    return SETUP_EXIT.ok;
  } catch (e) {
    if (e instanceof SetupCancelledError || entry.signal?.aborted) {
      io.stderr(`review-bot: setup stopped; the running installer was killed\n`);
      return entry.stoppedBy?.() === "SIGINT" ? 130 : 143;
    }
    if (e instanceof ConfigError || e instanceof SetupConfigError) {
      io.stderr(`review-bot: configuration error: ${e.message}\n`);
      return SETUP_EXIT.config;
    }
    if (e instanceof PackageInstallError) {
      io.stderr(`review-bot: install failed: ${e.message}\n`);
      return SETUP_EXIT.installFailed;
    }
    throw e;
  }
}

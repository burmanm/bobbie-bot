/**
 * The pi package's entry: the `/review-bot` command (F-3, A-2, R-1a step 3).
 * It runs the same review as `review-bot review`, with the same options
 * (src/cli/review.ts), from inside pi. Each model step is still its own SDK
 * session that the pipeline creates (D-2); this command only starts it.
 *
 * Unlike `pi-review/extension/` (the tools loaded into each role session,
 * which import only `core`), this entry may import every module (A-2).
 *
 * pi's headless mode does not report failure by itself, so each row of
 * F-3's table is handled here or by the launcher (src/cli/launch.ts):
 * - a throwing handler exits 0: the command catches everything and sets the
 *   exit code itself;
 * - SIGTERM exits without waiting: `session_shutdown` stops the run and
 *   awaits it, so what exists is published and the run record written;
 * - `console.log` goes to stderr: the result is written with `--out`;
 * - a malformed `settings.json` is only a warning, a missing package is
 *   skipped offline: the review reads and checks both first and stops with a
 *   configuration error.
 * Loading by path (`-ne -e`), stdin, `--no-approve` and the empty working
 * directory are the launcher's.
 *
 * Interactively, without `--dry-run` or `--live`, the run is a dry run. In
 * print mode (CI) the default is the CLI's: live.
 */
import { writeSync } from "node:fs";
import { type ExtensionAPI, type ExtensionCommandContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { requireExplicitBareRepository } from "../../src/core/git-env.ts";
import { CommandArgsError, splitCommandArgs } from "../../src/cli/command-args.ts";
import { type Io, REVIEW_OPTIONS_USAGE, runReviewCommand } from "../../src/cli/review.ts";

export const COMMAND_NAME = "review-bot";

const USAGE = `Usage:
  /review-bot --fixture <dir> [options]        dry run of a fixture PR
  /review-bot --pr <owner/repo#N | PR URL> [options]

Runs the same review as \`review-bot review\` and takes the same options.
Interactively it is a dry run unless --live is given; in print mode
(pi -p, CI) it posts unless --dry-run is given, as the CLI does. The
result JSON is written only with --out. Without --agent-dir the
configuration is pi's own agent directory (F-7).

${REVIEW_OPTIONS_USAGE}`;

/** Synchronous: pi ends the process with process.exit, which would drop pending pipe writes. */
const stderrSync = (text: string) => {
  try {
    writeSync(2, text);
  } catch {
    // stderr closed: nothing left to tell.
  }
};

function ioFor(ctx: ExtensionCommandContext): Io {
  if (!ctx.hasUI) return { stdout: stderrSync, stderr: stderrSync };
  const show = (type: "info" | "error") => (text: string) => {
    const trimmed = text.trimEnd();
    if (trimmed !== "") ctx.ui.notify(trimmed, type);
  };
  return { stdout: show("info"), stderr: show("info") };
}

export default function reviewBotCommand(pi: ExtensionAPI): void {
  // The agent directory pi was started with, read before any step points
  // PI_CODING_AGENT_DIR at a private one (C-3a).
  const piAgentDir = getAgentDir();
  let running: { controller: AbortController; done: Promise<unknown> } | undefined;

  pi.registerCommand(COMMAND_NAME, {
    description: "Review a pull request or a fixture with review-bot (dry run unless --live)",
    handler: async (text, ctx) => {
      const io = ioFor(ctx);
      const finish = (code: number) => {
        // In print mode the exit code is the run's; pi would exit 0 (F-3).
        if (!ctx.hasUI) process.exitCode = code;
        else if (code !== 0) ctx.ui.notify(`review-bot: exit code ${code}`, "error");
      };
      if (running !== undefined) {
        io.stderr("review-bot: a review is already running in this pi\n");
        finish(2);
        return;
      }
      const controller = new AbortController();
      const run = (async () => {
        let argv: string[];
        try {
          argv = splitCommandArgs(text);
        } catch (e) {
          if (!(e instanceof CommandArgsError)) throw e;
          io.stderr(`${e.message}\n\n${USAGE}`);
          return 2;
        }
        // Before anything can run git near a snapshot (C-3a), ACP-only runs included.
        requireExplicitBareRepository(process.env);
        return runReviewCommand(argv, io, {
          usage: USAGE,
          trigger: "pi-command",
          defaultDryRun: ctx.hasUI,
          printResult: false,
          defaultAgentDir: piAgentDir,
          signal: controller.signal,
        });
      })();
      running = { controller, done: run.catch(() => undefined) };
      try {
        finish(await run);
      } catch (e) {
        io.stderr(`review-bot: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
        finish(1);
      } finally {
        running = undefined;
      }
    },
  });

  // SIGTERM (a cancelled CI job) and quitting pi end here: stop the run and
  // wait for it to publish what exists and write the run record (F-3, S-9).
  pi.on("session_shutdown", async () => {
    const current = running;
    if (current === undefined) return;
    current.controller.abort();
    await current.done;
  });
}

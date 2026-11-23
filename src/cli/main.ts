#!/usr/bin/env node
/**
 * `review-bot` CLI (A-2):
 *
 *   review-bot review --pr <owner/repo#N> [options]            live (R-2)
 *   review-bot review --dry-run --pr <owner/repo#N> [options]
 *   review-bot review --dry-run --fixture <dir> [--script <file>] [options]
 *   review-bot launch [review options]      the same review as the pi
 *                                           command /review-bot (F-3)
 *   review-bot setup --agent-dir <dir>      install the operator's pi
 *                                           packages, scripts off (F-7)
 *
 * A dry run reads the PR (GitHub read-only through `gh`, or a fixture), runs
 * the pipeline, and prints the would-be review instead of posting it. A live
 * run posts it with the installation token in GH_TOKEN or GITHUB_TOKEN (C-5) and prints
 * what it did. Logs go to stderr; the JSON goes to stdout and, with --out,
 * to a file.
 *
 * Exit codes: 0 reviewed or skipped, 1 could not complete (neutral check),
 * 2 usage error. `setup` has its own (src/cli/setup.ts).
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { requireExplicitBareRepository } from "../core/git-env.ts";
import { CI_COMMANDS, CI_USAGE, type CiCommand, runCi } from "./ci.ts";
import { LAUNCH_USAGE, runLaunch } from "./launch.ts";
import { type Io, type LiveDeps, REVIEW_OPTIONS_USAGE, runReviewCommand } from "./review.ts";
import { runSetupCommand, SETUP_USAGE } from "./setup.ts";

export { type Io, type LiveDeps, parseWaiting } from "./review.ts";

const USAGE = `Usage:
  review-bot review --pr <owner/repo#N | PR URL> [options]
  review-bot review --dry-run --pr <owner/repo#N | PR URL> [options]
  review-bot review --dry-run --fixture <dir> [options]

Without --dry-run the review, thread replies and check run are posted to
GitHub with the token in GH_TOKEN (else GITHUB_TOKEN): the Actions
GITHUB_TOKEN or a GitHub App installation token (personal access tokens are refused). GITHUB_API_URL
and GITHUB_GRAPHQL_URL are honoured.

${REVIEW_OPTIONS_USAGE}
${LAUNCH_USAGE}
${SETUP_USAGE}
${CI_USAGE}`;

const processIo: Io = {
  stdout: (t) => void process.stdout.write(t),
  stderr: (t) => void process.stderr.write(t),
};

export async function main(argv: string[], io: Io = processIo, deps: LiveDeps = {}): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    io.stdout(USAGE);
    return command === undefined ? 2 : 0;
  }
  if ((CI_COMMANDS as readonly string[]).includes(command)) return runCi(command as CiCommand, rest, io);
  if (command === "setup") return withSignals((signal, stoppedBy) => runSetupCommand(rest, io, { signal, stoppedBy }));
  if (command !== "review" && command !== "launch") {
    io.stderr(`unknown command: ${command}\n\n${USAGE}`);
    return 2;
  }
  // Before anything can run git near a snapshot, ACP-only runs included,
  // and inherited by the pi that `launch` starts (C-3a, R-1a step 3).
  requireExplicitBareRepository(process.env);
  if (command === "launch") return runLaunch(rest, io);

  return withSignals((signal) =>
    runReviewCommand(rest, io, {
      ...deps,
      usage: USAGE,
      trigger: "cli",
      defaultDryRun: false,
      printResult: true,
      signal,
    }),
  );
}

/** SIGINT and SIGTERM abort `body` instead of ending the process at once. */
async function withSignals<T>(body: (signal: AbortSignal, stoppedBy: () => NodeJS.Signals | undefined) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let received: NodeJS.Signals | undefined;
  const onSignal = (name: NodeJS.Signals) => {
    received ??= name;
    controller.abort();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    return await body(controller.signal, () => received);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

// Run when executed directly (import.meta.main is not in every supported Node 22).
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`review-bot: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exitCode = 1;
    },
  );
}

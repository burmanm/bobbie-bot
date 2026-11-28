/**
 * Test helper (H-55, C-3): which lines of a step's log the GitHub Actions
 * runner would act on as workflow commands. Follows actions/runner (main,
 * read 2026-11-27):
 *
 * - Lines are split by .NET `StreamReader.ReadLine`: at `\n`, `\r\n` and a
 *   lone `\r` (src/Runner.Sdk/ProcessInvoker.cs).
 * - `::name props::data` after leading whitespace is tried first
 *   (`ActionCommand.TryParseV2`); then the legacy `##[name props]data`
 *   **anywhere in the line**: the first `##[` found (`ActionCommand.TryParse`).
 *   The name must be registered, compared case-insensitively.
 * - `stop-commands` ignores every command, in both syntaxes, until a line
 *   whose command name is the token (`ActionCommandManager.TryProcessCommand`).
 *
 * The runner reads stdout and stderr as separate queues and, within one
 * batch, hands stderr lines over first, so the two streams are checked
 * separately: nothing guarantees their relative order.
 */

const REGISTERED = [
  "stop-commands",
  "set-env",
  "set-output",
  "save-state",
  "add-mask",
  "add-path",
  "add-matcher",
  "remove-matcher",
  "debug",
  "warning",
  "error",
  "notice",
  "group",
  "endgroup",
  "echo",
];

export interface RunnerCommand {
  name: string;
  data: string;
  line: string;
}

function parse(line: string, registered: Set<string>): { name: string; data: string } | undefined {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("::")) {
    const end = trimmed.indexOf("::", 2);
    if (end >= 0) {
      const info = trimmed.slice(2, end);
      const name = info.split(" ")[0]!;
      if (registered.has(name.toLowerCase())) return { name: name.toLowerCase(), data: trimmed.slice(end + 2) };
    }
  }
  const start = line.indexOf("##[");
  if (start < 0) return undefined;
  const rb = line.indexOf("]", start);
  if (rb < 0) return undefined;
  const name = line.slice(start + 3, rb).split(" ")[0]!;
  return registered.has(name.toLowerCase()) ? { name: name.toLowerCase(), data: line.slice(rb + 1) } : undefined;
}

/** The commands the runner would carry out for one output stream, in order. */
export function runnerCommands(stream: string): RunnerCommand[] {
  const registered = new Set(REGISTERED);
  const done: RunnerCommand[] = [];
  let stopToken: string | undefined;
  for (const line of stream.split(/\r\n|\r|\n/)) {
    const cmd = parse(line, registered);
    if (cmd === undefined) continue;
    if (stopToken !== undefined) {
      if (cmd.name === stopToken) {
        registered.delete(stopToken);
        stopToken = undefined;
      }
      continue;
    }
    if (cmd.name === "stop-commands") {
      const token = cmd.data.toLowerCase();
      if (token === "" || registered.has(token) || token === "pause-logging") throw new Error(`the runner refuses stop token ${cmd.data}`);
      stopToken = token;
      registered.add(token);
      continue;
    }
    done.push({ ...cmd, line });
  }
  return done;
}

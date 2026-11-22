/**
 * `grep` and `find` that search everything in the snapshot.
 *
 * pi's own tools honour `.gitignore`/`.ignore` (and `find` needs the `fd`
 * binary). A PR controls those files, so it could hide code from the
 * reviewer (C-3 "cannot hide anything", Q-14). These replacements run
 * ripgrep with every ignore source switched off. Both use `rg` only; `fd`
 * is not needed. Neither downloads anything: a missing `rg` is an error
 * (C-3a "no downloads in the job that holds secrets").
 *
 * Relative and omitted paths resolve in head, not in the session's cwd
 * (C-3a).
 *
 * Ripgrep does not follow symlinks while walking a directory, so a symlink
 * pointing out of a root is not searched through.
 */
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import {
  createFindToolDefinition,
  DEFAULT_MAX_BYTES,
  type FindOperations,
  formatSize,
  type ToolDefinition,
  truncateHead,
  truncateLine,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AllowedRoots } from "./paths.ts";
import { resolveInHead } from "./read-tools.ts";

/** Flags shared by every ripgrep call. */
const RG_BASE_ARGS = [
  "--no-config", // ignore RIPGREP_CONFIG_PATH: no preprocessors, no ambient flags
  "--no-ignore", // .gitignore, .ignore, .rgignore, global and parent ignore files
  "--hidden", // dot-files and dot-directories (.github/, .pi/)
  "--color=never",
];

export const RG_MISSING =
  "ripgrep (rg) is not installed on PATH. The review job must provide it; it is never downloaded (C-3a).";

/** Locate an executable on PATH without running or downloading anything. */
export function findExecutable(name: string, pathEnv: string = process.env.PATH ?? ""): string | undefined {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}

const DEFAULT_GREP_LIMIT = 100;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

const grepSchema = Type.Object({
  pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
  path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
  glob: Type.Optional(
    Type.String({
      description:
        "Filter files by glob pattern, relative to path, e.g. '*.ts' or 'src/**/*.ts'. A pattern without '/' matches file names at any depth",
    }),
  ),
  ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
  literal: Type.Optional(Type.Boolean({ description: "Treat pattern as a literal string (default: false)" })),
  context: Type.Optional(Type.Number({ description: "Lines to show before and after each match (default: 0)" })),
  limit: Type.Optional(Type.Number({ description: `Maximum number of matches (default: ${DEFAULT_GREP_LIMIT})` })),
});

function decodeRgText(data: { text?: unknown; bytes?: unknown } | undefined): string {
  if (typeof data?.text === "string") return data.text;
  if (typeof data?.bytes === "string") return Buffer.from(data.bytes, "base64").toString("utf-8");
  return "";
}

export interface SearchToolOptions {
  /** Path to `rg`. Default: looked up on PATH when the tool runs. */
  rgPath?: string;
}

function requireRg(options: SearchToolOptions): string {
  const rg = options.rgPath ?? findExecutable("rg");
  if (!rg) throw new Error(RG_MISSING);
  return rg;
}

export function createSearchGrepTool(
  roots: AllowedRoots,
  options: SearchToolOptions = {},
): ToolDefinition<typeof grepSchema, undefined> {
  return {
    name: "grep",
    label: "grep",
    description: `Search file contents for a pattern. Returns matching lines with file paths (relative to the searched directory) and line numbers. Searches every file, including hidden files and files listed in .gitignore or .ignore. Output is limited to ${DEFAULT_GREP_LIMIT} matches by default or ${DEFAULT_MAX_BYTES / 1024}KB; long lines are truncated.`,
    promptSnippet: "Search file contents for patterns (every file, ignore files are not honoured)",
    parameters: grepSchema,
    async execute(_toolCallId, params, signal) {
      const rg = requireRg(options);
      const checked = roots.check(params.path ?? ".", roots.head);
      if (!checked.ok) throw new Error(checked.reason);
      const searchPath = roots.resolveForAccess(checked.path);
      const isDirectory = (await stat(searchPath)).isDirectory();
      const limit = Math.max(1, Math.floor(params.limit ?? DEFAULT_GREP_LIMIT));
      const context = params.context && params.context > 0 ? Math.min(Math.floor(params.context), 1000) : 0;

      const args = [...RG_BASE_ARGS, "--json", "--line-number", "--text"];
      if (params.ignoreCase) args.push("--ignore-case");
      if (params.literal) args.push("--fixed-strings");
      if (params.glob) args.push("--glob", params.glob.replace(/^(!?)(?:\.\/)+/, "$1"));
      if (context > 0) args.push("--context", String(context));
      args.push("--", params.pattern, isDirectory ? "." : searchPath);

      const lines = await runRg(rg, args, isDirectory ? searchPath : undefined, signal, (event, push) => {
        const isMatch = event.type === "match";
        if (!isMatch && event.type !== "context") return;
        const file = decodeRgText(event.data?.path).replace(/^\.\//, "");
        const lineNumber = event.data?.line_number;
        if (!file || typeof lineNumber !== "number") return;
        const shown = isDirectory ? file : (checked.path.split("/").pop() ?? file);
        const text = truncateLine(decodeRgText(event.data?.lines).replace(/\r?\n$/, "").replace(CONTROL_CHARS, "?")).text;
        return push(isMatch ? `${shown}:${lineNumber}: ${text}` : `${shown}-${lineNumber}- ${text}`, isMatch, limit);
      });

      if (lines.matches === 0) return { content: [{ type: "text", text: "No matches found" }], details: undefined };
      const truncation = truncateHead(lines.output.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
      const notices: string[] = [];
      if (lines.limitReached) notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`);
      if (truncation.truncated) notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
      if (lines.errors) notices.push(`Some files could not be searched: ${lines.errors.slice(0, 200)}`);
      const text = notices.length > 0 ? `${truncation.content}\n\n[${notices.join(". ")}]` : truncation.content;
      return { content: [{ type: "text", text }], details: undefined };
    },
  };
}

/** pi's `find`, with the file listing done by `rg --files` instead of `fd`. */
export function createSearchFindTool(roots: AllowedRoots, options: SearchToolOptions = {}) {
  const operations: FindOperations = {
    exists: (p) => {
      try {
        roots.resolveForAccess(p);
        return true;
      } catch {
        return false;
      }
    },
    // pi passes `ignore: [node_modules, .git]`. Not applied: what is skipped
    // comes only from REVIEW.md on the base branch (C-3).
    glob: async (pattern, searchPath, { limit }) => {
      const rg = requireRg(options);
      const dir = roots.resolveForAccess(searchPath);
      // Match fd's semantics as pi uses it: a pattern without '/' matches
      // file names at any depth; one with '/' may start at any depth.
      let glob = pattern.replace(/^(?:\.\/)+/, "");
      if (glob.includes("/") && !glob.startsWith("/") && !glob.startsWith("**/")) glob = `**/${glob}`;
      const args = [...RG_BASE_ARGS, "--files", "--glob", glob, "."];
      const result = await runRg(rg, args, dir, undefined, undefined, limit);
      return result.output;
    },
  };
  const definition = resolveInHead(createFindToolDefinition(roots.head, { operations }), roots.head);
  return {
    ...definition,
    description:
      "Search for files by glob pattern. Returns matching file paths relative to the search directory. Lists every file, including hidden files and files listed in .gitignore or .ignore.",
    promptSnippet: "Find files by glob pattern (every file, ignore files are not honoured)",
  };
}

interface RgJsonEvent {
  type?: string;
  data?: { path?: { text?: unknown; bytes?: unknown }; lines?: { text?: unknown; bytes?: unknown }; line_number?: unknown };
}

interface RgResult {
  output: string[];
  matches: number;
  limitReached: boolean;
  errors: string;
}

type Push = (line: string, isMatch: boolean, limit: number) => boolean | void;

/**
 * Run ripgrep and collect its output.
 * - With `onJson`, stdout is ripgrep's JSON stream and `onJson` turns events
 *   into lines; returning `false` from `push` stops ripgrep.
 * - Without it, each stdout line is a result, up to `maxLines`.
 */
function runRg(
  rg: string,
  args: string[],
  cwd: string | undefined,
  signal: AbortSignal | undefined,
  onJson?: (event: RgJsonEvent, push: Push) => boolean | void,
  maxLines?: number,
): Promise<RgResult> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(new Error("Operation aborted"));
      return;
    }
    const child = spawn(rg, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const rl = createInterface({ input: child.stdout });
    const result: RgResult = { output: [], matches: 0, limitReached: false, errors: "" };
    let stopped = false;
    let aborted = false;
    let bytes = 0;
    const stop = () => {
      if (!stopped) {
        stopped = true;
        child.kill();
      }
    };
    const onAbort = () => {
      aborted = true;
      stop();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const push: Push = (line, isMatch, limit) => {
      if (isMatch && result.matches >= limit) {
        result.limitReached = true;
        stop();
        return false;
      }
      if (isMatch) result.matches++;
      // Past the byte cap lines are counted but not kept; truncateHead cuts there anyway.
      if (bytes <= DEFAULT_MAX_BYTES) result.output.push(line);
      bytes += Buffer.byteLength(line) + 1;
      return true;
    };

    rl.on("line", (line) => {
      if (stopped || !line) return;
      if (onJson) {
        let event: RgJsonEvent;
        try {
          event = JSON.parse(line) as RgJsonEvent;
        } catch {
          return;
        }
        onJson(event, push);
        return;
      }
      if (maxLines !== undefined && result.output.length >= maxLines) {
        result.limitReached = true;
        stop();
        return;
      }
      result.output.push(line.replace(/^\.\//, ""));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (result.errors.length < 4096) result.errors += chunk.toString();
    });
    child.on("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      reject(new Error(`Failed to run ripgrep: ${error.message}`));
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      rl.close();
      if (aborted) {
        reject(new Error("Operation aborted"));
        return;
      }
      result.errors = result.errors.trim();
      // 0: matches, 1: none, 2: an error (possibly alongside matches).
      if (!stopped && code !== 0 && code !== 1 && result.output.length === 0) {
        reject(new Error(result.errors || `ripgrep exited with code ${code}`));
        return;
      }
      resolvePromise(result);
    });
  });
}

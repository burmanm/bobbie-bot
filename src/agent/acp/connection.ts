/**
 * A minimal Agent Client Protocol (ACP) client connection: JSON-RPC 2.0,
 * one message per line, over the stdio of an agent process we start. Only
 * what `AcpAgentStep` needs; no dependency on an ACP SDK.
 *
 * Requests from the agent go to `onRequest`; a handler that throws an
 * `RpcError` answers with that error. Notifications go to `onNotification`.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";

export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/** The agent process could not be started, or ended while we were talking to it. */
export class AgentExitedError extends Error {
  /** True when the process never started (for example the command does not exist). */
  readonly startFailed: boolean;
  constructor(message: string, startFailed = false) {
    super(message);
    this.startFailed = startFailed;
  }
}

export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
/** ACP: the agent needs `authenticate` first. */
export const AUTH_REQUIRED = -32000;
/** ACP: a resource (for example a file) was not found. */
export const RESOURCE_NOT_FOUND = -32002;

export interface AcpConnectionOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  onRequest(method: string, params: unknown): Promise<unknown>;
  onNotification(method: string, params: unknown): void;
}

const STDERR_TAIL = 4096;

export class AcpConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private nextId = 1;
  private stderrTail = "";
  private exitError: AgentExitedError | undefined;
  private readonly options: AcpConnectionOptions;
  readonly exited: Promise<void>;

  constructor(options: AcpConnectionOptions) {
    this.options = options;
    this.child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.exited = new Promise((resolve) => {
      this.child.once("error", (e) => {
        this.fail(new AgentExitedError(`cannot start ACP agent "${options.command}": ${e.message}`, true));
        resolve();
      });
      this.child.once("exit", (code, signal) => {
        const how = signal !== null ? `signal ${signal}` : `code ${code}`;
        const tail = this.stderrTail.trim();
        this.fail(new AgentExitedError(`ACP agent exited (${how})${tail ? `: ${tail}` : ""}`));
        resolve();
      });
    });
    this.child.stdin.on("error", () => {}); // EPIPE after the agent exits; reported through `exit`.
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL);
    });
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.onLine(line));
  }

  get stderr(): string {
    return this.stderrTail;
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.exitError !== undefined) return Promise.reject(this.exitError);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.exitError === undefined) this.send({ jsonrpc: "2.0", method, params });
  }

  /** Close stdin, then SIGTERM, then SIGKILL; resolves when the process is gone. */
  async close(graceMs = 2_000): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null || this.exitError !== undefined) return;
    this.child.stdin.end();
    const gone = await Promise.race([this.exited.then(() => true), delay(graceMs / 2).then(() => false)]);
    if (gone) return;
    this.child.kill("SIGTERM");
    const termed = await Promise.race([this.exited.then(() => true), delay(graceMs / 2).then(() => false)]);
    if (!termed) {
      this.child.kill("SIGKILL");
      await this.exited;
    }
  }

  private send(message: unknown): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private fail(error: AgentExitedError): void {
    if (this.exitError !== undefined) return;
    this.exitError = error;
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }

  private onLine(line: string): void {
    if (line.trim() === "") return;
    let msg: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown } };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // Not ours to fix; agents sometimes log to stdout.
    }
    if (typeof msg.method === "string") {
      if (msg.id === undefined || msg.id === null) {
        this.options.onNotification(msg.method, msg.params);
        return;
      }
      const id = msg.id;
      this.options.onRequest(msg.method, msg.params).then(
        (result) => this.send({ jsonrpc: "2.0", id, result: result ?? null }),
        (e: unknown) => {
          const err = e instanceof RpcError ? e : new RpcError(INTERNAL_ERROR, e instanceof Error ? e.message : String(e));
          this.send({ jsonrpc: "2.0", id, error: { code: err.code, message: err.message, ...(err.data === undefined ? {} : { data: err.data }) } });
        },
      );
      return;
    }
    if (typeof msg.id !== "number") return;
    const waiter = this.pending.get(msg.id);
    if (waiter === undefined) return;
    this.pending.delete(msg.id);
    if (msg.error !== undefined) {
      const code = typeof msg.error.code === "number" ? msg.error.code : INTERNAL_ERROR;
      const message = typeof msg.error.message === "string" ? msg.error.message : "unknown error";
      waiter.reject(new RpcError(code, message, msg.error.data));
    } else {
      waiter.resolve(msg.result);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

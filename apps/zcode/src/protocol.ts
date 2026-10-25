import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";

/** NDJSON stdio client for `zcode app-server --stdio` (ZCode Protocol v4 wire 3). */
export interface ServerRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

export class ProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export interface ProtocolHandlers {
  /** Answer server-to-client requests (runtime preferences, provider auth, ...). */
  onRequest(request: ServerRequest): Promise<unknown>;
  /** Observe notifications (v4/conversation/frame, state.updated, ...). */
  onNotification(message: Record<string, any>): void;
}

export class ProtocolClient {
  private proc?: ChildProcess;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private buffer = "";
  private stopped = false;
  private sawFrame = false;
  private readyWaiters = new Map<() => void, () => void>();
  /** Set when the child exits or the stream breaks; cleared on reconnect. */
  exited = false;
  onExit?: (code: number | null) => void;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly options: { cwd: string; handlers: ProtocolHandlers },
  ) {}

  start() {
    if (this.proc) throw new Error("already started");
    this.stopped = false;
    this.exited = false;
    const proc = spawn(this.command, this.args, {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc = proc;
    proc.stdout!.setEncoding("utf8");
    proc.stdout!.on("data", (chunk: string) => this.receive(chunk));
    proc.stderr!.setEncoding("utf8");
    proc.stderr!.on("data", (chunk: string) => {
      // Surface native diagnostics (signing failures, crashes) for triage.
      for (const line of chunk.split("\n"))
        if (line.trim()) console.error(JSON.stringify({ native: line.slice(0, 500) }));
    });
    proc.on("exit", (code) => {
      this.exited = true;
      const error = new ProtocolError(-32000, "app-server exited");
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      this.pending.clear();
      this.onExit?.(code);
    });
  }

  /** Resolves on the first stdout frame (server finished protocol bootstrap). */
  ready(timeoutMs = 20000): Promise<void> {
    if (this.sawFrame) return Promise.resolve();
    if (this.exited) return Promise.reject(new ProtocolError(-32000, "app-server exited"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiters.delete(resolve);
        if (this.sawFrame) resolve();
        else reject(new ProtocolError(-32000, "app-server produced no frames"));
      }, timeoutMs);
      this.readyWaiters.set(resolve, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private markFrame() {
    if (this.sawFrame) return;
    this.sawFrame = true;
    for (const resolve of this.readyWaiters.keys()) resolve();
    this.readyWaiters.clear();
  }

  private receive(chunk: string) {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message: Record<string, any>;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      this.markFrame();
      if (message.method !== undefined && message.id !== undefined) {
        void this.handleServerRequest(message);
      } else if (message.method !== undefined) {
        this.options.handlers.onNotification(message);
      } else if (message.id !== undefined) {
        const entry = this.pending.get(message.id);
        if (entry) {
          this.pending.delete(message.id);
          clearTimeout(entry.timer);
          if (message.error)
            entry.reject(
              new ProtocolError(
                message.error.code,
                message.error.message,
                message.error.data,
              ),
            );
          else entry.resolve(message.result);
        }
      }
    }
  }

  private async handleServerRequest(request: ServerRequest) {
    try {
      const result = await this.options.handlers.onRequest(request);
      this.write({ id: request.id, result });
    } catch (error: any) {
      this.write({
        id: request.id,
        error: {
          code: error instanceof ProtocolError ? error.code : -32603,
          message: String(error?.message ?? error),
        },
      });
    }
  }

  private write(message: unknown) {
    if (this.exited || this.stopped) return;
    this.proc?.stdin?.write(JSON.stringify(message) + "\n", (error) => {
      if (error) this.exited = true;
    });
  }

  request<T = unknown>(method: string, params?: unknown, timeout = 30000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ProtocolError(-32000, `app-server request timeout: ${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  stop() {
    this.stopped = true;
    const proc = this.proc;
    this.proc = undefined;
    if (proc && proc.exitCode === null && !proc.killed) proc.kill();
  }
}

/** Default runtime preferences the desktop host reports for headless sessions. */
export const runtimePreferences = {
  nativeSearchEnhancementsEnabled: true,
  toolSearchMode: "off",
  memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: true,
  modelContextBudgetStrategy: "preflight-v1",
} as const;

export const uuid = randomUUID;

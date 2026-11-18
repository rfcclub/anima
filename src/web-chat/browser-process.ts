import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { privateDirectory } from "./private-fs";
import {
  BrowserFailure,
  type BrowserRunner,
  type ChatConversation,
  type ChatRequest,
  type TurnBaseline,
} from "./types";
import type { BrowserOptions } from "./browser";
interface Call {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  event?: (kind: string, args: any[]) => void;
}
export class BrowserProcess implements BrowserRunner {
  private child?: ChildProcess;
  private starting?: Promise<void>;
  private exited?: Promise<void>;
  private closed = false;
  private count = 0;
  private failure?: Error;
  private stopping?: Promise<void>;
  private readonly calls = new Map<string, Call>();
  constructor(private readonly options: BrowserOptions) {}
  get openPages() {
    return this.count;
  }
  private async start() {
    if (this.closed) throw Error("browser stopped");
    if (this.starting) return this.starting;
    this.starting = (async () => {
      let entry = join(import.meta.dir, "web-chat-browser-worker.mjs");
      if (!existsSync(entry)) {
        const root = privateDirectory(this.options.root);
        entry = join(root, "browser-worker.mjs");
        const result = await Bun.build({
          entrypoints: [join(import.meta.dir, "browser-worker.ts")],
          target: "node",
          plugins: [
            {
              name: "installed-playwright",
              setup(build) {
                build.onResolve({ filter: /^playwright$/ }, () => ({
                  path: Bun.resolveSync("playwright", import.meta.dir),
                  external: true,
                }));
              },
            },
          ],
        });
        if (!result.success) throw Error("browser worker build failed");
        const output = (await result.outputs[0]!.text()).replaceAll(
          '"playwright"',
          JSON.stringify(
            pathToFileURL(Bun.resolveSync("playwright", import.meta.dir)).href,
          ),
        );
        await Bun.write(entry, output);
        await import("node:fs/promises").then((fs) => fs.chmod(entry, 0o600));
      }
      const node = Bun.which("node");
      if (!node) throw Error("Node runtime required for web chat");
      const child = (this.child = spawn(node, [entry], {
        stdio: ["pipe", "pipe", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          LANG: process.env.LANG,
          TZ: process.env.TZ,
          DISPLAY: process.env.DISPLAY,
          PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
        },
      }));
      (child.stdio[3] as import("node:stream").Writable).end(
        JSON.stringify(this.options),
      );
      child.stderr!.resume();
      const fail = () => {
        this.failure ??= Error("browser child exited");
        for (const call of this.calls.values()) call.reject(this.failure);
        this.calls.clear();
        this.count = 0;
      };
      this.exited = new Promise<void>((resolve) => {
        child.once("exit", () => {
          fail();
          resolve();
        });
        child.once("error", () => {
          fail();
          resolve();
        });
      });
      child.stdin!.on("error", fail);
      (child.stdio[3] as import("node:stream").Writable).on("error", fail);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(Error("browser worker startup timeout"));
        }, 10_000);
        child.once("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        child.once("exit", () => {
          clearTimeout(timer);
          reject(Error("browser worker exited"));
        });
        const lines = createInterface({ input: child.stdout! });
        lines.on("line", (line) => {
          if (line.length > 600_000) {
            child.kill("SIGKILL");
            return;
          }
          let v: any;
          try {
            v = JSON.parse(line);
          } catch {
            fail();
            child.kill("SIGKILL");
            return;
          }
          if (v.kind === "ready") {
            clearTimeout(timer);
            resolve();
            return;
          }
          const call = this.calls.get(v.id);
          if (!call) return;
          if (v.kind === "submitted" || v.kind === "baseline") {
            call.event?.(v.kind, v.args);
            return;
          }
          this.count = v.openPages ?? this.count;
          this.calls.delete(v.id);
          if (v.kind === "error")
            call.reject(
              v.error.state === "interrupted"
                ? Error("browser interrupted")
                : new BrowserFailure(v.error.state, v.error.beforeSubmission),
            );
          else call.resolve(v.result);
        });
      });
    })();
    return this.starting;
  }
  private async call(
    operation: Record<string, unknown>,
    signal?: AbortSignal,
    event?: Call["event"],
  ): Promise<any> {
    await this.start();
    if (this.failure) throw this.failure;
    if (this.closed) throw Error("browser stopped");
    signal?.throwIfAborted();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const abort = () =>
        this.child!.stdin!.write(
          JSON.stringify({ operation: "cancel", target: id }) + "\n",
        );
      const done = (fn: (v: any) => void, value: any) => {
        signal?.removeEventListener("abort", abort);
        fn(value);
      };
      this.calls.set(id, {
        resolve: (value) => done(resolve, value),
        reject: (error) => done(reject, error),
        event,
      });
      signal?.addEventListener("abort", abort, { once: true });
      this.child!.stdin!.write(JSON.stringify({ ...operation, id }) + "\n");
    });
  }
  async run(
    c: ChatConversation,
    prompt: string,
    signal: AbortSignal,
    submitted: (id: string, url: string, b?: TurnBaseline) => void,
    baseline?: (b: TurnBaseline) => void,
  ) {
    return this.call(
      { operation: "run", conversation: c, prompt },
      signal,
      (kind, args) => {
        if (kind === "submitted") submitted(args[0], args[1], args[2]);
        else baseline?.(args[0]);
      },
    );
  }
  async reconcile(
    conversation: ChatConversation,
    request: ChatRequest,
    signal: AbortSignal,
  ) {
    return this.call({ operation: "reconcile", conversation, request }, signal);
  }
  async login(account: string) {
    return this.call({ operation: "login", account });
  }
  async finishLogin(account: string): Promise<void> {
    if (this.starting && !this.closed)
      await this.call({ operation: "finish-login", account });
  }
  async close(conversationId: string) {
    if (this.starting && !this.closed)
      await this.call({ operation: "close", conversationId });
  }
  shutdown(): Promise<void> {
    return (this.stopping ??= (async () => {
      this.closed = true;
      if (!this.starting) return;
      await this.starting.catch(() => {});
      if (!this.child) return;
      this.child.stdin!.end();
      const timer = setTimeout(() => this.child?.kill("SIGKILL"), 5000);
      await this.exited;
      clearTimeout(timer);
    })());
  }
}

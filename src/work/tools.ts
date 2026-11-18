/**
 * The tools a work session offers its model (anima #135, WL-10): bash, read, write and edit. Each call runs as its own
 * supervised child under the write boundary (see sandbox.ts), with only the sanitised environment, in the work's
 * tree. Nothing here runs in the host process on the model's behalf, so a path trick or a symlink cannot make the
 * host write outside the work root. A failing call is reported as text; none of these functions throws.
 */

import { lstatSync } from "node:fs";
import type { LoopHostTools } from "../agents/loop";
import type { ProviderToolCall, ProviderToolDefinition } from "../providers/interface";
import { sandboxCommand, sanitizedEnv, SANDBOX_BINARY } from "./sandbox";
import { spawnSession, sweepRoot, type SessionHandle, type StopResult } from "./supervisor";

export interface WorkToolsInput {
  root: string;
  tree: string;
  tmp: string;
  home: string;
  denyReadRoots: string[];
  /** Wall limit of one tool call. */
  perCallMs: number;
  /** The process environment to filter; only an allow-list reaches the tools. */
  parentEnv: Record<string, string | undefined>;
  binary?: string;
  /** Characters of output kept per call. Default 60,000. */
  maxOutput?: number;
}

export interface WorkTools extends LoopHostTools {
  /** Stops anything still running from this session's tools and looks for strays in the work root. */
  stopAll(): Promise<StopResult>;
}

const def = (name: string, description: string, properties: Record<string, unknown>, required: string[]): ProviderToolDefinition => ({
  name, description, parameters: { type: "object", properties, required },
});

const DEFINITIONS: ProviderToolDefinition[] = [
  def("bash", "Run a shell command in the work tree and return its combined output. Writes are limited to this work's directory; Unix sockets are limited to its temporary directory and other network access is denied.", { command: { type: "string", description: "The shell command to run" } }, ["command"]),
  def("read", "Read a file (optionally a window of lines).", {
    path: { type: "string", description: "File path, relative to the work tree or absolute" },
    offset: { type: "number", description: "First line to return (1-based)" },
    limit: { type: "number", description: "Number of lines to return" },
  }, ["path"]),
  def("write", "Write content to a file in the work tree, replacing it.", {
    path: { type: "string", description: "File path, relative to the work tree" },
    content: { type: "string", description: "The full content" },
  }, ["path", "content"]),
  def("edit", "Replace the first occurrence of old_string with new_string in a file.", {
    path: { type: "string", description: "File path, relative to the work tree" },
    old_string: { type: "string", description: "Exact text to find" },
    new_string: { type: "string", description: "Text to put in its place" },
  }, ["path", "old_string", "new_string"]),
];

/** A relative path gets a `./` so a name that starts with a dash can never be read as an option. */
const operand = (path: string) => (path.startsWith("/") ? path : `./${path}`);

/**
 * Run with `bun -e`. Bun can exit 0 after an uncaught native error in `-e` code when it runs under the write
 * boundary (seen with a denied write), so the script never relies on an exit code: it catches everything and
 * prints `OK <n>`, `NOTFOUND` or `ERR <message>`, and the caller accepts only `OK`.
 */
const EDIT_SCRIPT = [
  "try{",
  "const fs=require('node:fs');",
  "const j=JSON.parse(fs.readFileSync(0,'utf8'));",
  "const t=fs.readFileSync(j.path,'utf8');",
  "const i=t.indexOf(j.old);",
  "if(i<0){console.log('NOTFOUND');process.exit(2)}",
  "fs.writeFileSync(j.path,t.slice(0,i)+j.new+t.slice(i+j.old.length));",
  "console.log('OK '+j.old.length)",
  "}catch(e){console.log('ERR '+(e&&e.message?e.message:String(e)));process.exit(3)}",
].join("");

export function createWorkTools(input: WorkToolsInput): WorkTools {
  const binary = input.binary ?? SANDBOX_BINARY;
  const maxOutput = input.maxOutput ?? 60_000;
  const active = new Set<SessionHandle>();

  const run = async (argv: string[], opts: { stdin?: string; signal?: AbortSignal } = {}) => {
    // A prior tool may have removed tmp or replaced it with a file. Let a later tool repair it
    // under the default no-network profile; a symlink is never accepted as a socket grant.
    let unixSocketRoot: string | undefined;
    try {
      const tmp = lstatSync(input.tmp);
      if (tmp.isSymbolicLink()) throw new RangeError("work temporary directory must not be a symlink");
      if (tmp.isDirectory()) unixSocketRoot = input.tmp;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const handle = spawnSession({
      argv: sandboxCommand({ writableRoots: [input.root], denyReadRoots: input.denyReadRoots, unixSocketRoot }, argv, binary),
      cwd: input.tree,
      env: sanitizedEnv(input.parentEnv, { home: input.home, tmp: input.tmp }),
      root: input.root,
      deadlineMs: input.perCallMs,
      captureChars: maxOutput,
      ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
    });
    active.add(handle);
    let aborted = false;
    const onAbort = () => { aborted = true; void handle.stopAndProve({ graceMs: 200 }); };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      const exit = await handle.exited;
      const out = await handle.output;
      return { text: out.text, truncated: out.truncated, code: exit.code, timedOut: exit.timedOut, aborted };
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
      active.delete(handle);
    }
  };

  const describe = (r: Awaited<ReturnType<typeof run>>): string => {
    let text = r.text;
    if (r.truncated) text += "\n…[output truncated]";
    if (r.timedOut) text += `\n[timed out after ${Math.round(input.perCallMs / 1000)}s and stopped]`;
    else if (r.aborted) text += "\n[aborted: stopped by the host]";
    else if (r.code !== 0) text += `\n[exit code ${r.code}]`;
    return text;
  };

  const failed = (r: Awaited<ReturnType<typeof run>>) => r.code !== 0 || r.timedOut || r.aborted;

  const execute = async (call: ProviderToolCall, signal?: AbortSignal): Promise<string> => {
    let args: Record<string, unknown>;
    try {
      const parsed = JSON.parse(call.arguments);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      args = parsed as Record<string, unknown>;
    } catch {
      return `Error: invalid arguments for ${call.name}: expected a JSON object`;
    }
    const str = (name: string): string | null => (typeof args[name] === "string" ? (args[name] as string) : null);
    try {
      switch (call.name) {
        case "bash": {
          const command = str("command");
          if (command === null) return "Error: bash needs a command (string)";
          return describe(await run(["bash", "-c", command], { signal }));
        }
        case "read": {
          const path = str("path");
          if (!path) return "Error: read needs a path (string)";
          const offset = typeof args.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 0;
          const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 100_000;
          const script = offset > 0 ? 'sed -n "${2},$(( $2 + $3 - 1 ))p" "$1"' : 'head -c 200000 "$1"';
          const r = await run(["sh", "-c", script, "sh", operand(path), String(offset), String(limit)], { signal });
          return failed(r) ? `Error: ${describe(r).trim()}` : r.text + (r.truncated ? "\n…[output truncated]" : "");
        }
        case "write": {
          const path = str("path");
          const content = str("content");
          if (!path) return "Error: write needs a path (string)";
          if (content === null) return "Error: write needs content (string)";
          const r = await run(["sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", operand(path)], { stdin: content, signal });
          return failed(r) ? `Error: ${describe(r).trim()}` : `wrote ${Buffer.byteLength(content)} bytes to ${path}`;
        }
        case "edit": {
          const path = str("path");
          const oldString = str("old_string");
          const newString = str("new_string");
          if (!path || oldString === null || newString === null) return "Error: edit needs path, old_string and new_string (strings)";
          const r = await run([process.execPath, "-e", EDIT_SCRIPT], { stdin: JSON.stringify({ path, old: oldString, new: newString }), signal });
          if (r.text.includes("NOTFOUND")) return `Error: old_string not found in ${path}`;
          // only an explicit OK is success; an exit code alone is not trusted here
          if (!/^OK \d+/m.test(r.text)) return `Error: ${(describe(r).trim() || "edit did not complete").replace(/^ERR /, "")}`;
          return `edited ${path}: replaced ${oldString.length} characters`;
        }
        default:
          return `Error: unknown tool ${call.name}`;
      }
    } catch (error) {
      return `Error: ${call.name} could not run: ${error instanceof Error ? error.message : String(error)}`;
    }
  };

  return {
    definitions: DEFINITIONS,
    execute,
    async stopAll(): Promise<StopResult> {
      const results = await Promise.all([...active].map((handle) => handle.stopAndProve({ graceMs: 200 })));
      const sweep = await sweepRoot(input.root);
      const swept = [...results.flatMap((r) => r.swept), ...sweep.swept];
      const survivors = [...results.flatMap((r) => r.survivors), ...sweep.survivors];
      const proven = results.every((r) => r.proven) && sweep.checked && sweep.survivors.length === 0;
      return proven ? { proven, swept, survivors } : { proven, reason: "cessation-unproven", swept, survivors };
    },
  };
}

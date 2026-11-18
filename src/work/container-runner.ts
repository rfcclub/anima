import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { VmHandle, VmRunner, VmStartInput } from "./vm";

/** Build arguments without placing the bearer token in the process table. */
export function containerCommand(input: VmStartInput, image: string, socket: string, home = join(input.root, "home")): string[] {
  if (!socket) throw new Error("private relay socket is required");
  return [
    "run", "--rm", "--name", `anima-w-${input.sessionId}`, "--network", "none",
    "--publish-socket", `${socket}:/run/anima/gw.sock`, "-v", `${input.root}:${input.root}`,
    "-w", join(input.root, "tree"), "--env", `HOME=${home}`,
    image, "python3", "/opt/anima/worker.py", "--yolo", "--json", "-m", input.model, input.task,
  ];
}

const OUTPUT_LIMIT = 128 * 1024;

/** The published relay must have an owner-only parent, regardless of TMPDIR. */
export function assertPrivateSocketDir(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error("unsafe relay socket directory");
  }
}

async function readOutput(stream: ReadableStream<Uint8Array>, secret: string): Promise<string> {
  const reader = stream.getReader();
  let output = "";
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    // Keep enough extra input to recognize a token crossing the output limit before truncating.
    const captureLimit = OUTPUT_LIMIT + secret.length;
    if (output.length < captureLimit) output += decoder.decode(value, { stream: true }).slice(0, captureLimit - output.length);
  }
  return output.replaceAll(secret, "[redacted]").slice(0, OUTPUT_LIMIT);
}

/** Launches one VM per session. The VM's own low sandbox is disabled; the VM is the boundary. */
export function createContainerRunner(options: { binary?: string; image?: string; readinessMs?: number } = {}): VmRunner {
  const binary = options.binary ?? "container";
  const image = options.image ?? "anima-worker:latest";
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? tmpdir() };

  async function control(args: string[]) {
    const p = Bun.spawn([binary, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code, out, err };
  }

  return {
    async start(input): Promise<VmHandle> {
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(input.sessionId)) throw new Error("invalid VM session id");
      if (!isAbsolute(input.root) || realpathSync(input.root) !== input.root) throw new Error("work root must be a canonical absolute path");
      const imageCheck = await control(["image", "inspect", image]);
      if (imageCheck.code !== 0) throw new Error(`worker image ${image} is unavailable: ${imageCheck.err.trim().slice(0, 200)}`);
      const gateway = new URL(input.gatewayUrl);
      if (gateway.protocol !== "http:" || gateway.hostname !== "127.0.0.1" || !gateway.port) {
        throw new Error("invalid session gateway");
      }
      const homeRoot = join(input.root, "home");
      if (lstatSync(homeRoot).isSymbolicLink() || !lstatSync(homeRoot).isDirectory()) throw new Error("unsafe work home");
      const home = mkdtempSync(join(homeRoot, ".low-session-"));
      const configDir = join(home, ".config", "low");
      let socketDir: string | undefined;
      try {
        mkdirSync(configDir, { recursive: true, mode: 0o700 });
        writeFileSync(join(configDir, "providers.toml"),
          `[session]\nbase_url = "http://127.0.0.1:8787/v1"\napi_key = ${JSON.stringify(input.gatewayToken)}\nmodels = [${JSON.stringify(input.model)}]\n`,
          { mode: 0o600, flag: "wx" });
        socketDir = mkdtempSync(join(tmpdir(), "anima-s7-"));
        chmodSync(socketDir, 0o700);
        assertPrivateSocketDir(socketDir);
      } catch (error) {
        const failures: unknown[] = [];
        try { if (socketDir) rmSync(socketDir, { recursive: true, force: true }); } catch (e) { failures.push(e); }
        try { rmSync(home, { recursive: true, force: true }); } catch (e) { failures.push(e); }
        if (failures.length) throw new AggregateError([error, ...failures], "worker setup and cleanup failed");
        throw error;
      }
      const socket = join(socketDir, "gw.sock");
      let child: ReturnType<typeof Bun.spawn>;
      try {
        child = Bun.spawn([binary, ...containerCommand(input, image, socket, home)], { env, stdout: "pipe", stderr: "pipe" });
      } catch (error) {
        rmSync(home, { recursive: true, force: true });
        rmSync(socketDir, { recursive: true, force: true });
        throw error;
      }

      const name = `anima-w-${input.sessionId}`;
      const stdout = readOutput(child.stdout as ReadableStream<Uint8Array>, input.gatewayToken);
      const stderr = readOutput(child.stderr as ReadableStream<Uint8Array>, input.gatewayToken);
      let exited = false;
      const exit = child.exited.then((code) => { exited = true; return { code }; });
      let stopped = false;
      let cleanupFailure: string | undefined;
      const sockets = new Set<Socket>();
      const timers = new Set<ReturnType<typeof setTimeout>>();
      const stopPump = () => {
        stopped = true;
        for (const timer of timers) clearTimeout(timer);
        for (const stream of sockets) stream.destroy();
        sockets.clear();
      };
      const addConnection = () => {
        if (stopped) return;
        const upstream = connect({ path: socket });
        sockets.add(upstream);
        let downstream: Socket | undefined;
        let retried = false;
        const retry = () => {
          if (retried) return;
          retried = true;
          upstream.destroy();
          downstream?.destroy();
          sockets.delete(upstream);
          if (downstream) sockets.delete(downstream);
          if (!stopped) {
            const timer = setTimeout(() => { timers.delete(timer); addConnection(); }, 50);
            timers.add(timer);
          }
        };
        upstream.on("error", retry).on("close", retry);
        // Leave pooled Unix sockets idle without an open Bun gateway connection: Bun closes
        // idle TCP connections, while the VM may retain its half in the relay queue.
        upstream.once("data", (first) => {
          upstream.pause();
          downstream = connect({ host: "127.0.0.1", port: Number(gateway.port) });
          sockets.add(downstream);
          downstream.on("error", retry).on("close", retry);
          downstream.write(first);
          upstream.pipe(downstream).pipe(upstream);
        });
      };
      const kill = async () => {
        stopPump();
        await control(["kill", name]).catch(() => {});
        await control(["rm", name]).catch(() => {});
      };
      const gone = async () => {
        const inspection = await control(["inspect", name]).catch(() => null);
        if (inspection?.code === 0) return false;
        let absent = inspection?.err.trim() === `Error: container not found: ${name}`;
        if (!absent) {
          // On an unfamiliar error, use the complete structured listing; never infer absence
          // from an error, a partial response, or a malformed listing.
          const listing = await control(["list", "--all", "--format", "json"]).catch(() => null);
          try {
            const entries: unknown = listing?.code === 0 ? JSON.parse(listing.out) : null;
            absent = Array.isArray(entries) && entries.every((entry) =>
              entry && typeof entry === "object" && typeof entry.id === "string") &&
              entries.every((entry) => entry.id !== name);
          } catch {
            absent = false;
          }
        }
        if (!absent) return false;
        stopPump();
        try {
          rmSync(socketDir, { recursive: true, force: true });
        } catch (error) {
          cleanupFailure = `relay cleanup failed: ${String(error)}`;
        }
        try {
          // After proven cessation the VM can no longer swap parents while we remove its private session home.
          if (lstatSync(homeRoot).isSymbolicLink()) throw new Error("work home became a symlink");
          rmSync(home, { recursive: true, force: true });
        } catch (error) {
          const failure = `session cleanup failed: ${String(error)}`;
          cleanupFailure = cleanupFailure ? `${cleanupFailure}; ${failure}` : failure;
        }
        return true;
      };
      const readyUntil = Date.now() + Math.min(input.timeoutMs, options.readinessMs ?? 15_000);
      while (!existsSync(join(home, ".relay-ready"))) {
        if (exited || Date.now() >= readyUntil) {
          await kill();
          await gone().catch(() => false);
          throw new Error(exited ? "worker VM exited before relay readiness" : "worker VM relay readiness timed out");
        }
        await Bun.sleep(25);
      }
      try {
        // The VM marker can arrive before the host forwarding socket. If it appears later,
        // the owner-only parent still protects it and the connection pump retries.
        if (existsSync(socket)) chmodSync(socket, 0o600);
      } catch (error) {
        await kill();
        await gone().catch(() => false);
        throw error;
      }
      // The marker is written only after the in-VM listener binds; a host socket path alone is not readiness.
      for (let i = 0; i < 4; i++) addConnection();
      return { exited: exit, kill, gone, cleanupError: () => cleanupFailure, output: async () => `${await stdout}${await stderr}`.slice(0, OUTPUT_LIMIT) };
    },
  };
}

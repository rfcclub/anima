// Node-only browser child. No listening socket, signing key, model-selected URL or script API.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { BrowserManager, type BrowserOptions } from "./browser";
import { BrowserFailure, SERVICES } from "./types";
const config = JSON.parse(readFileSync(3, "utf8")) as BrowserOptions;
process.umask(0o077);
const manager = new BrowserManager(config),
  controllers = new Map<string, AbortController>();
const send = (value: unknown) =>
  process.stdout.write(JSON.stringify(value) + "\n");
const input = createInterface({ input: process.stdin });
let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  for (const controller of controllers.values()) controller.abort();
  await manager.shutdown();
  process.exit(0);
};
input.on("close", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
input.on("line", async (line) => {
  if (line.length > 512_000) {
    void shutdown();
    return;
  }
  let v: any;
  try {
    v = JSON.parse(line);
  } catch {
    void shutdown();
    return;
  }
  if (v.operation === "cancel") {
    controllers.get(v.target)?.abort();
    return;
  }
  const controller = new AbortController();
  controllers.set(v.id, controller);
  try {
    let result: unknown;
    switch (v.operation) {
      case "run":
        result = await manager.run(
          v.conversation,
          v.prompt,
          controller.signal,
          (...args) => send({ id: v.id, kind: "submitted", args }),
          (value) => send({ id: v.id, kind: "baseline", args: [value] }),
        );
        break;
      case "reconcile":
        result = await manager.reconcile(
          v.conversation,
          v.request,
          controller.signal,
        );
        break;
      case "close":
        await manager.close(v.conversationId);
        result = { closed: true };
        break;
      case "login": {
        const account = config.accounts.find((a) => a.id === v.account);
        if (!account) throw Error("unknown account");
        const context = await manager.login(account.id),
          page = context.pages()[0] ?? (await context.newPage());
        await page.goto(config.fixture?.url ?? SERVICES[account.service], {
          timeout: 15_000,
        });
        result = { opened: true };
        break;
      }
      case "finish-login":
        await manager.finishLogin(v.account);
        result = { finished: true };
        break;
      case "shutdown":
        await shutdown();
        return;
      default:
        throw Error("unknown browser operation");
    }
    send({ id: v.id, kind: "result", result, openPages: manager.openPages });
  } catch (e) {
    send({
      id: v.id,
      kind: "error",
      error:
        e instanceof BrowserFailure
          ? { state: e.state, beforeSubmission: e.beforeSubmission }
          : { state: "interrupted" },
      openPages: manager.openPages,
    });
  } finally {
    controllers.delete(v.id);
  }
});
send({ kind: "ready" });

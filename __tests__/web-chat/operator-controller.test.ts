import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperatorController } from "../../src/web-chat/operator";
import { WebChatService } from "../../src/web-chat/service";
import { BrowserFailure, type BrowserRunner } from "../../src/web-chat/types";
import type { BridgeConfig } from "../../src/web-chat/config";

const roots: string[] = [];
const services: WebChatService[] = [];
const controllers: OperatorController[] = [];
function setup(
  browser?: BrowserRunner,
  finishLogin = async (_account: string) => {},
) {
  const root = mkdtempSync(join(tmpdir(), "console-controller-"));
  roots.push(root);
  const config: BridgeConfig = {
    accounts: [{ id: "a", service: "claude" }],
    privateSources: [],
  };
  writeFileSync(join(root, "config.json"), JSON.stringify(config), {
    mode: 0o600,
  });
  const calls: string[] = [];
  const runner = {
    run: async () => ({
      text: "OK",
      turnId: "new-turn",
      url: "https://claude.ai/chat/fixture",
    }),
    close: async () => {},
    ...browser,
    login: async (account: string) => {
      calls.push(`login:${account}`);
    },
    finishLogin: async (account: string) => {
      calls.push(`finish:${account}`);
      await finishLogin(account);
    },
  };
  const service = new WebChatService({
    root,
    accounts: config.accounts,
    browser: runner,
  });
  services.push(service);
  const controller = new OperatorController({
    root,
    config,
    service,
    browser: runner,
  });
  controllers.push(controller);
  return { root, config, service, controller, calls };
}
afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.shutdown();
  for (const service of services.splice(0)) await service.shutdown();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("SC-3/SC-4: login is owner-bound, never validation, and cleanup finishes before lease release", async () => {
  let release!: () => void;
  const s = setup(
    undefined,
    async () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await s.controller.startLogin("operator-one", "a");
  expect(s.calls).toEqual(["login:a"]);
  expect(s.service.list()[0].reason).toBe("maintenance");
  await expect(s.controller.finishLogin("other", "a")).rejects.toThrow("owner");
  const finishing = s.controller.finishLogin("operator-one", "a");
  await Bun.sleep(0);
  expect(s.service.list()[0].reason).toBe("maintenance");
  release();
  await finishing;
  expect(s.service.list()[0]).toMatchObject({
    available: false,
    reason: "unverified",
  });
  expect(
    JSON.parse(readFileSync(join(s.root, "config.json"), "utf8")).accounts[0]
      .validatedVersion,
  ).toBeUndefined();
  expect(existsSync(join(s.root, "validation-a.json"))).toBe(false);
});

test("SC-3: only a completed explicit challenge writes a private service-bound receipt", async () => {
  let sent = "";
  const s = setup({
    run: async (_c, prompt) => {
      sent = prompt;
      return {
        text: "OK",
        turnId: "new-answer",
        url: "https://claude.ai/chat/new",
      };
    },
    close: async () => {},
  });
  const receipt = await s.controller.validate("operator-one", "a", {
    prompt: "Answer this public validation challenge",
    planTier: "operator-declared",
  });
  expect(sent).toContain("Answer this public validation challenge");
  expect(sent).toContain("Validation nonce:");
  expect(receipt.service).toBe("claude");
  expect(receipt.turnId).toBe("new-answer");
  const persisted = JSON.parse(
    readFileSync(join(s.root, "config.json"), "utf8"),
  ).accounts[0];
  expect(persisted.validatedService).toBe("claude");
  expect(persisted.validatedVersion).toBeDefined();
  expect(s.service.list()[0].available).toBe(true);
  expect(statSync(join(s.root, "validation-a.json")).mode & 0o777).toBe(0o600);
  expect(readFileSync(join(s.root, "validation-a.json"), "utf8")).not.toContain(
    "Answer this public",
  );
});

test("SC-3/SC-5: rejected/failed validation cannot enable an account or bypass private-source checks", async () => {
  let calls = 0;
  const s = setup({
    run: async () => {
      calls++;
      throw new BrowserFailure("unsupported_page", true);
    },
    close: async () => {},
  });
  await expect(
    s.controller.validate("one", "a", { prompt: "short", planTier: "x" }),
  ).rejects.toThrow("challenge");
  s.service.registerPrivateContent(
    "A PRIVATE BOOT SENTENCE THAT MUST NEVER GO TO A CHATBOT",
  );
  await expect(
    s.controller.validate("one", "a", {
      prompt: "A PRIVATE BOOT SENTENCE THAT MUST NEVER GO TO A CHATBOT",
      planTier: "x",
    }),
  ).rejects.toThrow("egress denied");
  expect(calls).toBe(0);
  await expect(
    s.controller.validate("one", "a", {
      prompt: "A sufficiently long public challenge",
      planTier: "x",
    }),
  ).rejects.toThrow("validation failed");
  expect(calls).toBe(1);
  expect(s.service.list()[0]).toMatchObject({
    available: false,
    reason: "unverified",
  });
  expect(existsSync(join(s.root, "validation-a.json"))).toBe(false);
});

test("SC-5: session release and shutdown close login windows and prevent later operations", async () => {
  const s = setup();
  await s.controller.startLogin("one", "a");
  await s.controller.releaseOwner("unrelated");
  expect(s.calls).toEqual(["login:a"]);
  await s.controller.releaseOwner("one");
  expect(s.calls).toEqual(["login:a", "finish:a"]);
  await s.controller.startLogin("two", "a");
  await s.controller.shutdown();
  expect(s.calls).toEqual(["login:a", "finish:a", "login:a", "finish:a"]);
  await expect(s.controller.startLogin("two", "a")).rejects.toThrow("stopped");
});

test("recovery-validation: uncertain validation identifies its durable request and offline remedy", async () => {
  const s = setup({
    run: async () => {
      throw new BrowserFailure("unknown_submission", false);
    },
    close: async () => {},
  });
  let message = "";
  try {
    await s.controller.validate("one", "a", {
      prompt: "A sufficiently long public challenge",
      planTier: "fixture",
    });
  } catch (error) {
    message = (error as Error).message;
  }
  const store = new (await import("../../src/web-chat/store")).ChatStore(
    s.root,
  );
  const request = store
    .requests()
    .find((r) => r.state === "unknown_submission")!;
  store.close();
  expect(request).toBeDefined();
  expect(() => s.service.acquireMaintenance("a")).toThrow("uncertain");
  expect(message).toContain(request.id);
  expect(message).toContain("Stop the console");
  expect(message).toContain("mark-sent");
  expect(message).toContain("mark-not-sent");
  expect(s.service.list()[0].available).toBe(false);
  expect(existsSync(join(s.root, "validation-a.json"))).toBe(false);
  await s.controller.shutdown();
  await s.service.shutdown();
  const maintenance = Bun.spawn(
    [
      process.execPath,
      "src/web-chat/cli.ts",
      "mark-not-sent",
      request.id,
      "--root",
      s.root,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [code, stdout, stderr] = await Promise.all([
    maintenance.exited,
    new Response(maintenance.stdout).text(),
    new Response(maintenance.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(stdout).toContain("Attestation recorded; no send performed");
  const recovered = new WebChatService({
    root: s.root,
    accounts: s.config.accounts,
    browser: {
      run: async () => {
        throw Error("offline recovery must not send");
      },
      close: async () => {},
    },
  });
  services.push(recovered);
  const release = recovered.acquireMaintenance("a");
  release();
  expect(recovered.list()[0].available).toBe(false);
});

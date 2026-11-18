import { startConsole } from "./console";
import {
  existsSync,
  openSync,
  closeSync,
  writeFileSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { acquireBridgeLock, readConfig } from "./config";
import { privateDirectory, privateFile, ChatStore } from "./store";
import { WebChatService } from "./service";
import { BrowserProcess as BrowserManager } from "./browser-process";
import {
  ADAPTER_VERSION,
  SERVICES,
  hasCurrentValidation,
  type ChatService,
} from "./types";
process.umask(0o077);
const args = process.argv.slice(2),
  option = (name: string) => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args[i + 1];
  };
const root =
  option("--root") ??
  process.env.ANIMA_WEB_CHAT_ROOT ??
  join(homedir(), ".anima", "web-chat");
async function main() {
  const command = args[0];
  if (command === "console") {
    const running = await startConsole({
      root,
      host: option("--host"),
      origin: option("--origin"),
      port:
        option("--port") === undefined ? undefined : Number(option("--port")),
    });
    console.log(`ANIMA Chat / Connect: ${running.url}`);
    console.log(
      `Unlock with the private token in ${join(root, "operator-token")}. Login opens a window on this host.`,
    );
    const stop = () => {
      void running.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return;
  }
  if (command === "init") {
    privateDirectory(root);
    const release = acquireBridgeLock(root);
    try {
      const file = join(root, "config.json"),
        fd = openSync(file, "wx", 0o600);
      writeFileSync(
        fd,
        JSON.stringify(
          {
            accounts: Object.keys(SERVICES).map((service) => ({
              id: service,
              service,
            })),
            privateSources: [],
          },
          null,
          2,
        ) + "\n",
      );
      closeSync(fd);
      console.log(
        "Initialized four UNVERIFIED accounts. Run manual login, then explicit validation.",
      );
    } finally {
      release();
    }
    return;
  }
  if (
    !["status", "login", "validate", "mark-sent", "mark-not-sent"].includes(
      command ?? "",
    )
  )
    throw Error(
      "usage: init | console [--port <port>] [--host 127.0.0.1|0.0.0.0] [--origin <exact HTTP origin>] | status | login <account> | validate <account> --prompt <unique challenge> --plan-tier <declared tier> | mark-sent/mark-not-sent <request>; optional --root <private directory>",
    );
  const release = acquireBridgeLock(root);
  let browser: BrowserManager | undefined, service: WebChatService | undefined;
  try {
    const config = readConfig(root);
    const account = config.accounts.find((a) => a.id === args[1]);
    if (command === "status") {
      console.log(
        JSON.stringify(
          config.accounts.map((a) => ({
            account: a.id,
            service: a.service,
            verified: hasCurrentValidation(a),
            declaredPlanTier: a.planTier ?? null,
          })),
          null,
          2,
        ),
      );
      return;
    }
    if (command === "mark-sent" || command === "mark-not-sent") {
      const store = new ChatStore(root);
      const request = store.request(args[1] ?? "");
      store.close();
      if (!request) throw Error("request not found");
      service = new WebChatService({
        root,
        accounts: config.accounts,
        browser: {
          run: async () => {
            throw Error("offline maintenance cannot send");
          },
          close: async () => {},
        },
      });
      service.resolve(
        request.owner,
        request.id,
        command === "mark-sent" ? "sent" : "not_sent",
      );
      console.log("Attestation recorded; no send performed.");
      return;
    }
    if (!account) throw Error("unknown configured account");
    browser = new BrowserManager({ root, accounts: config.accounts });
    if (command === "login") {
      await browser.login(account.id);
      console.log(
        "Complete login/2FA/CAPTCHA manually in the dedicated window. Press Enter when finished. This does not validate the adapter.",
      );
      const input = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        await input.question("");
      } finally {
        input.close();
      }
      return;
    }
    const prompt = option("--prompt"),
      planTier = option("--plan-tier");
    if (!prompt || prompt.trim().length < 16 || !planTier)
      throw Error(
        "validation requires a unique prompt (>=16 characters) and a declared plan tier",
      );
    // Enable only this explicit operator attempt in memory; persist availability only after proven completion.
    service = new WebChatService({
      root,
      accounts: config.accounts.map((a) =>
        a.id === account.id
          ? {
              ...a,
              validatedVersion: ADAPTER_VERSION,
              validatedService: a.service,
            }
          : a,
      ),
      limits: config.limits,
      browser,
    });
    for (const path of config.privateSources)
      service.registerPrivateContent(readFileSync(path, "utf8"));
    const owner = { agent: "operator-validation", session: randomUUID() },
      conversation = service.create(owner, account.id),
      request = service.send(owner, {
        conversationId: conversation.id,
        retryKey: randomUUID(),
        prompt,
      });
    const stop = () => service!.cancel(owner, request.id);
    process.once("SIGINT", stop);
    try {
      let result = service.result(owner, request.id);
      while (["queued", "sending", "waiting"].includes(result.state)) {
        await Bun.sleep(100);
        result = service.result(owner, request.id);
      }
      if (result.state !== "completed" || !result.turnId)
        throw Error(
          `validation failed: ${result.state}; adapter remains unverified`,
        );
      const evidence = {
        account: account.id,
        service: account.service,
        declaredPlanTier: planTier,
        adapterVersion: ADAPTER_VERSION,
        requestId: request.id,
        conversationId: conversation.id,
        turnId: result.turnId,
        url: result.url,
        startedAt: request.createdAt,
        completedAt: result.updatedAt,
        promptDigest: request.audit.promptDigest,
        answerDigest: createHash("sha256")
          .update(result.answer ?? "")
          .digest("hex"),
        usage: null,
      };
      const evidenceFile = join(root, `validation-${account.id}.json`);
      if (existsSync(evidenceFile)) privateFile(evidenceFile);
      writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + "\n", {
        mode: 0o600,
      });
      account.validatedVersion = ADAPTER_VERSION;
      account.validatedService = account.service;
      account.planTier = planTier;
      const temporary = join(root, "config-" + randomUUID() + ".tmp");
      writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temporary, join(root, "config.json"));
      console.log(JSON.stringify(evidence, null, 2));
    } finally {
      process.off("SIGINT", stop);
    }
  } finally {
    await service?.shutdown();
    await browser?.shutdown();
    release();
  }
}
main().catch(() => {
  process.stderr.write(
    "Web chat command failed. Check command arguments, private ownership, and adapter state. No automatic retry.\n",
  );
  process.exitCode = 1;
});

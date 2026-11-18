import { createHash, randomUUID } from "node:crypto";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BridgeConfig } from "./config";
import { privateFile } from "./private-fs";
import { WebChatService } from "./service";
import { ADAPTER_VERSION, type ChatOwner, type ChatRequest } from "./types";

interface OperatorBrowser {
  login(account: string): Promise<unknown>;
  finishLogin(account: string): Promise<void>;
}
interface Login {
  owner: string;
  release: () => void;
  ready: Promise<unknown>;
  timer: ReturnType<typeof setTimeout>;
  finishing?: Promise<void>;
}
interface Validation {
  owner: string;
  runtimeOwner: ChatOwner;
  request?: ChatRequest;
  task?: Promise<unknown>;
}
interface Options {
  root: string;
  config: BridgeConfig;
  service: WebChatService;
  browser: OperatorBrowser;
  loginTimeoutMs?: number;
}

/** Trusted operator composition. None of these methods are agent IPC operations. */
export class OperatorController {
  private readonly logins = new Map<string, Login>();
  private readonly validations = new Set<Validation>();
  private stopped = false;
  constructor(private readonly options: Options) {}

  private account(id: string) {
    if (this.stopped) throw Error("operator console stopped");
    const account = this.options.config.accounts.find((a) => a.id === id);
    if (!account) throw Error("unknown configured account");
    return account;
  }

  async startLogin(owner: string, id: string) {
    this.account(id);
    const release = this.options.service.acquireMaintenance(id);
    const entry: Login = {
      owner,
      release,
      ready: Promise.resolve(),
      timer: setTimeout(() => {
        void this.finishLogin(owner, id).catch(() => {});
      }, this.options.loginTimeoutMs ?? 600_000),
    };
    this.logins.set(id, entry);
    entry.ready = this.options.browser.login(id);
    try {
      await entry.ready;
    } catch (error) {
      await this.finishLogin(owner, id);
      throw error;
    }
    return { opened: true, verified: false };
  }

  async finishLogin(owner: string, id: string): Promise<void> {
    const entry = this.logins.get(id);
    if (!entry || entry.owner !== owner) throw Error("login owner denied");
    return (entry.finishing ??= (async () => {
      clearTimeout(entry.timer);
      await entry.ready.catch(() => {});
      // A cleanup failure keeps the lease fenced until the console is stopped.
      await this.options.browser.finishLogin(id);
      entry.release();
      this.logins.delete(id);
    })());
  }

  async validate(
    owner: string,
    id: string,
    input: { prompt: string; planTier: string },
  ) {
    const account = this.account(id);
    if (
      typeof input.prompt !== "string" ||
      input.prompt.trim().length < 16 ||
      typeof input.planTier !== "string" ||
      !input.planTier.trim() ||
      input.planTier.length > 80
    )
      throw Error(
        "validation requires a public challenge (>=16 characters) and a declared plan tier",
      );
    const runtimeOwner = {
      agent: "operator-validation",
      session: randomUUID(),
    };
    const release = this.options.service.acquireMaintenance(id, runtimeOwner);
    const validation: Validation = { owner, runtimeOwner };
    this.validations.add(validation);
    const task = (async () => {
      const service = this.options.service;
      let conversationId: string | undefined;
      try {
        const conversation = service.create(runtimeOwner, id);
        conversationId = conversation.id;
        const request = service.send(runtimeOwner, {
          conversationId,
          retryKey: randomUUID(),
          prompt: `${input.prompt}\nValidation nonce: ${randomUUID()}`,
        });
        validation.request = request;
        let result = service.result(runtimeOwner, request.id);
        while (["queued", "sending", "waiting"].includes(result.state)) {
          await Bun.sleep(100);
          result = service.result(runtimeOwner, request.id);
        }
        if (result.state !== "completed" || !result.turnId)
          throw Error(
            `validation failed: ${result.state}; request ${request.id}; account remains unverified.` +
              (result.state === "unknown_submission"
                ? ` Stop the console, inspect the website on the host, then use mark-sent ${request.id} or mark-not-sent ${request.id} with the same --root. Record an attestation only after checking; never retry automatically.`
                : ""),
          );
        const receipt = {
          account: id,
          service: account.service,
          declaredPlanTier: input.planTier,
          adapterVersion: ADAPTER_VERSION,
          requestId: request.id,
          conversationId,
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
        const receiptPath = join(this.options.root, `validation-${id}.json`);
        if (existsSync(receiptPath)) privateFile(receiptPath);
        this.writeAtomic(receiptPath, receipt);
        const updated = {
          ...account,
          validatedVersion: ADAPTER_VERSION,
          validatedService: account.service,
          planTier: input.planTier,
        };
        this.writeAtomic(join(this.options.root, "config.json"), {
          ...this.options.config,
          accounts: this.options.config.accounts.map((a) =>
            a.id === id ? updated : a,
          ),
        });
        Object.assign(account, updated);
        return receipt;
      } finally {
        if (conversationId) await service.close(runtimeOwner, conversationId);
        release();
      }
    })();
    validation.task = task;
    try {
      return await task;
    } finally {
      this.validations.delete(validation);
    }
  }

  private writeAtomic(path: string, value: unknown) {
    const temporary = join(this.options.root, `operator-${randomUUID()}.tmp`);
    writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, path);
  }

  async releaseOwner(owner: string) {
    const work: Promise<unknown>[] = [];
    for (const [account, entry] of this.logins)
      if (entry.owner === owner) work.push(this.finishLogin(owner, account));
    for (const validation of this.validations) {
      if (validation.owner !== owner) continue;
      if (validation.request)
        this.options.service.cancel(
          validation.runtimeOwner,
          validation.request.id,
        );
      if (validation.task) work.push(validation.task);
    }
    await Promise.allSettled(work);
  }

  async shutdown() {
    this.stopped = true;
    const owners = new Set([
      ...[...this.logins.values()].map((entry) => entry.owner),
      ...[...this.validations].map((entry) => entry.owner),
    ]);
    await Promise.all([...owners].map((owner) => this.releaseOwner(owner)));
  }
}

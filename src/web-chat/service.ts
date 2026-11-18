import { createHash, randomUUID } from "node:crypto";
import { ChatStore } from "./store";
import {
  ADAPTER_VERSION,
  BrowserFailure,
  DEFAULT_LIMITS,
  SERVICES,
  hasCurrentValidation,
  type BrowserAnswer,
  type BrowserRunner,
  type ChatAccount,
  type ChatConversation,
  type ChatLimits,
  type ChatOwner,
  type ChatRequest,
  type ChatResult,
  type RefusalCategory,
} from "./types";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const same = (a: ChatOwner, b: ChatOwner) =>
  a.agent === b.agent && a.session === b.session;
const activeStates = new Set(["queued", "sending", "waiting"]);
const SECRET =
  /-----BEGIN (?:[A-Z ]*PRIVATE KEY)-----|\b(?:sk-[a-zA-Z0-9_-]{20,}|gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,}|AKIA[A-Z0-9]{16})\b|(?:authorization\s*:\s*bearer\s+|(?:api[_ -]?key|password|secret[_ -]?key|access[_ -]?token)\s*[=:]\s*["']?)[a-zA-Z0-9_+\/.=-]{12,}/i;
interface ServiceOptions {
  root: string;
  accounts: ChatAccount[];
  adapterVersion?: string;
  browser: BrowserRunner;
  limits?: Partial<ChatLimits>;
  now?: () => number;
}
interface Pending {
  request: ChatRequest;
  prompt: string;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  running: boolean;
}
export class WebChatService {
  private readonly store: ChatStore;
  private readonly accounts: Map<string, ChatAccount>;
  private readonly browser: BrowserRunner;
  private readonly version: string;
  private readonly limits: ChatLimits;
  private readonly now: () => number;
  private readonly pending = new Map<string, Pending>();
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly busy = new Set<string>();
  private readonly maintenance = new Map<string, symbol>();
  private readonly validationOwners = new Map<string, ChatOwner>();
  private readonly privateContent = new Map<number, Set<string>>();
  private privateEntries = 0;
  private stopping = false;
  private lastPurge = -Infinity;
  private shutdownTask?: Promise<void>;
  private readonly reconciliations = new Map<string, AbortController>();
  constructor(opts: ServiceOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    const maxima: ChatLimits = {
      global: 4,
      queue: 64,
      promptChars: 64_000,
      answerChars: 128_000,
      deadlineMs: 600_000,
    };
    for (const key of Object.keys(maxima) as (keyof ChatLimits)[])
      if (
        !Number.isSafeInteger(this.limits[key]) ||
        this.limits[key] <= 0 ||
        this.limits[key] > maxima[key]
      )
        throw Error("invalid limit");
    this.accounts = new Map(opts.accounts.map((a) => [a.id, a]));
    if (this.accounts.size !== opts.accounts.length)
      throw Error("duplicate account");
    for (const a of opts.accounts)
      if (
        !/^[a-zA-Z0-9_-]{1,64}$/.test(a.id) ||
        !Object.hasOwn(SERVICES, a.service) ||
        (a.deadlineMs !== undefined &&
          (!Number.isSafeInteger(a.deadlineMs) ||
            a.deadlineMs <= 0 ||
            a.deadlineMs > 600_000))
      )
        throw Error("invalid account");
    this.browser = opts.browser;
    this.version = opts.adapterVersion ?? ADAPTER_VERSION;
    this.now = opts.now ?? Date.now;
    this.store = new ChatStore(opts.root);
    this.store.transaction(() => {
      for (const request of this.store.requests()) {
        if (request.state === "queued")
          this.transition(request, "failed", "restart_before_submission");
        else if (request.state === "sending" || request.state === "waiting") {
          this.transition(
            request,
            "unknown_submission",
            "restart_during_submission",
          );
          this.block(request.conversationId);
        }
      }
    });
    this.purge();
  }
  list() {
    return [...this.accounts.values()].map((a) => ({
      account: a.id,
      service: a.service,
      available:
        !this.maintenance.has(a.id) && hasCurrentValidation(a, this.version),
      reason: this.maintenance.has(a.id)
        ? "maintenance"
        : hasCurrentValidation(a, this.version)
          ? undefined
          : "unverified",
    }));
  }
  /** Trusted operator composition only; deliberately absent from agent IPC dispatch. */
  acquireMaintenance(account: string, validationOwner?: ChatOwner): () => void {
    if (this.stopping) throw Error("bridge stopped");
    if (!this.accounts.has(account)) throw Error("unknown configured account");
    if (this.maintenance.has(account)) throw Error("account in maintenance");
    if (
      this.busy.has(account) ||
      [...this.pending.values()].some(
        (p) => p.request.audit.account === account,
      )
    )
      throw Error("account busy");
    if (
      this.store
        .requests()
        .some(
          (r) =>
            r.audit.account === account && r.state === "unknown_submission",
        )
    )
      throw Error(
        "account has uncertain submission; reconcile or attest offline first",
      );
    const lease = Symbol();
    if (validationOwner) {
      this.owner(validationOwner);
      this.validationOwners.set(account, { ...validationOwner });
    }
    this.maintenance.set(account, lease);
    return () => {
      if (this.maintenance.get(account) === lease) {
        this.maintenance.delete(account);
        this.validationOwners.delete(account);
      }
    };
  }
  private validationAttempt(account: string, owner: ChatOwner): boolean {
    const expected = this.validationOwners.get(account);
    return !!expected && same(expected, owner);
  }
  registerPrivateContent(content: string) {
    if (content.length > 1_000_000)
      throw Error("private source registration full");
    const normalized = content.normalize("NFKC").trim();
    // Index bounded excerpts by length. A prompt is scanned once per length,
    // instead of once per registered excerpt; long sources cannot stall sends.
    const add = (text: string) => {
      const excerpt = text.slice(0, 64);
      if (!excerpt) return;
      let entries = this.privateContent.get(excerpt.length);
      if (entries?.has(excerpt)) return;
      if (this.privateEntries >= 80_000)
        throw Error(
          `private source registry full (${this.privateEntries}/80000 entries); restart the web-chat bridge or reduce registered boot content`,
        );
      if (!entries)
        this.privateContent.set(excerpt.length, (entries = new Set()));
      entries.add(excerpt);
      this.privateEntries++;
      if (this.privateEntries === 40_001)
        console.warn(
          JSON.stringify({
            event: "web_chat_private_registry_capacity",
            entries: this.privateEntries,
            limit: 80_000,
          }),
        );
    };
    const register = (text: string) => {
      add(text);
      add(text.replace(/[\s"'+]/g, ""));
    };
    if (normalized.length >= 24) register(normalized);
    for (const line of normalized.split(/\r?\n/))
      if (line.trim().length >= 24) register(line.trim());
    for (let i = 0; i + 64 <= normalized.length; i += 32)
      register(normalized.slice(i, i + 64));
  }
  private owner(owner: ChatOwner) {
    if (
      !owner ||
      typeof owner.agent !== "string" ||
      !owner.agent ||
      typeof owner.session !== "string" ||
      !owner.session ||
      owner.agent.length > 128 ||
      owner.session.length > 128
    )
      throw Error("missing runtime owner");
  }
  private conversation(owner: ChatOwner, id: string) {
    this.purge();
    this.owner(owner);
    const c = this.store.conversation(id);
    if (!c || !same(c.owner, owner)) throw Error("owner denied");
    return c;
  }
  private request(owner: ChatOwner, id: string) {
    this.owner(owner);
    const r = this.store.request(id);
    if (!r || !same(r.owner, owner)) throw Error("owner denied");
    return r;
  }
  create(owner: ChatOwner, account: string) {
    this.purge();
    this.owner(owner);
    if (this.stopping) throw Error("bridge stopped");
    if (this.store.conversations().length >= 256)
      throw Error("conversation capacity reached");
    const a = this.accounts.get(account);
    const validation = this.validationAttempt(account, owner);
    if (this.maintenance.has(account) && !validation)
      throw Error("account in maintenance");
    if (!a || (!validation && !hasCurrentValidation(a, this.version)))
      throw Error("account unverified or unavailable");
    const c: ChatConversation = {
      id: randomUUID(),
      createdAt: this.now(),
      owner: { ...owner },
      account,
      service: a.service,
      blocked: false,
      closed: false,
    };
    this.store.putConversation(c);
    return c;
  }
  resume(owner: ChatOwner, id: string) {
    return this.conversation(owner, id);
  }
  history(owner: ChatOwner) {
    this.owner(owner);
    this.purge();
    const requests = this.store.requests().filter((r) => same(r.owner, owner));
    const counts = new Map<string, number>();
    const visible = new Set<string>();
    // Window each conversation independently. Never hide a request that can
    // still be running or require recovery, even beyond the display window.
    for (const request of requests.toReversed()) {
      const count = counts.get(request.conversationId) ?? 0;
      counts.set(request.conversationId, count + 1);
      if (
        count < 20 ||
        ["queued", "sending", "waiting", "unknown_submission"].includes(
          request.state,
        )
      )
        visible.add(request.id);
    }
    return {
      conversations: this.store
        .conversations()
        .filter((c) => same(c.owner, owner)),
      requests: requests.filter((r) => visible.has(r.id)),
      // Content-free proof that a send was refused before any browser action.
      refusals: this.store.refusals(owner.agent, owner.session),
    };
  }
  send(
    owner: ChatOwner,
    args: { conversationId: string; retryKey: string; prompt: string },
  ) {
    const c = this.conversation(owner, args.conversationId);
    if (
      typeof args.prompt !== "string" ||
      !args.prompt.trim() ||
      args.prompt.length > this.limits.promptChars
    )
      throw Error("invalid prompt length");
    if (
      typeof args.retryKey !== "string" ||
      !args.retryKey ||
      args.retryKey.length > 128
    )
      throw Error("invalid retry key");
    const digest = hash(args.prompt);
    const scope = JSON.stringify([
      owner.agent,
      owner.session,
      c.id,
      args.retryKey,
    ]);
    const old = this.store.byScope(scope);
    if (old) {
      if (old.audit.promptDigest !== digest) throw Error("retry conflict");
      if (old.reason === "expired")
        throw Error("request expired; use an explicit new key");
      return old;
    }
    if (this.stopping) throw Error("bridge stopped");
    if (c.closed) throw Error("conversation closed");
    const validation = this.validationAttempt(c.account, owner);
    if (this.maintenance.has(c.account) && !validation)
      throw Error("account in maintenance");
    if (c.blocked) throw Error("conversation blocked pending reconciliation");
    if (
      [...this.pending.values()].some((p) => p.request.conversationId === c.id)
    )
      throw Error("conversation busy");
    const account = this.accounts.get(c.account);
    if (!validation && !hasCurrentValidation(account, this.version))
      throw Error("account unverified");
    const normalized = args.prompt.normalize("NFKC");
    const decoded = [normalized];
    // Only recognizable encodings are inspected; this is deliberately not a universal DLP claim.
    for (const match of normalized.matchAll(/\b[A-Za-z0-9+/]{32,}={0,2}\b/g)) {
      try {
        decoded.push(Buffer.from(match[0], "base64").toString("utf8"));
      } catch {}
    }
    decoded.push(...decoded.map((d) => d.replace(/[\s"'+]/g, "")));
    const refusal: RefusalCategory | undefined = decoded.some((t) =>
      SECRET.test(t),
    )
      ? "secret"
      : decoded.some((text) => {
            for (const [length, entries] of this.privateContent)
              for (let offset = 0; offset + length <= text.length; offset++)
                if (entries.has(text.slice(offset, offset + length)))
                  return true;
            return false;
          })
        ? "private_source"
        : undefined;
    if (refusal) {
      // A refusal happened before any browser action: leave a content-free receipt.
      this.store.putRefusal({
        id: randomUUID(),
        owner: { ...owner },
        conversationId: c.id,
        account: c.account,
        service: c.service,
        category: refusal,
        promptLength: args.prompt.length,
        at: this.now(),
      });
      throw Error("egress denied: secret or private source");
    }
    if (
      [...this.pending.values()].filter((p) => !p.running).length >=
      this.limits.queue
    )
      throw Error("queue full");
    if (this.store.requests().length >= 10_000)
      throw Error("request capacity reached");
    const at = this.now();
    const r: ChatRequest = {
      id: randomUUID(),
      owner: { ...owner },
      conversationId: c.id,
      retryKey: args.retryKey,
      audit: {
        agent: owner.agent,
        session: owner.session,
        conversationId: c.id,
        account: c.account,
        service: c.service,
        promptDigest: digest,
        promptLength: args.prompt.length,
        at,
      },
      state: "queued",
      createdAt: at,
      deadlineAt: at + (account?.deadlineMs ?? this.limits.deadlineMs),
      updatedAt: at,
      truncated: false,
      late: false,
      usage: null,
    };
    this.store.transaction(() => {
      this.store.putRequest(r, scope);
      this.store.event(r);
    });
    const pending: Pending = {
      request: r,
      prompt: args.prompt,
      controller: new AbortController(),
      timer: setTimeout(
        () => this.expire(r.id),
        Math.max(1, r.deadlineAt - at),
      ),
      running: false,
    };
    this.pending.set(r.id, pending);
    queueMicrotask(() => this.pump());
    return r;
  }
  result(owner: ChatOwner, id: string, after = 0): ChatResult {
    if (!Number.isSafeInteger(after) || after < 0)
      throw Error("invalid cursor");
    this.purge();
    const r = this.request(owner, id);
    const cursor = this.store.lastCursor(id);
    if (after !== 0 && !this.store.hasCursor(id, after))
      throw Error("cursor belongs to another request or expired");
    return { ...r, events: this.store.events(id, after), cursor };
  }
  cancel(owner: ChatOwner, id: string) {
    const r = this.request(owner, id);
    const p = this.pending.get(id);
    if (p) {
      this.transition(
        p.request,
        p.running ? "unknown_submission" : "cancelled",
        "cancelled",
      );
      if (p.running) this.block(r.conversationId);
      p.controller.abort();
      if (!p.running) this.remove(p);
    }
    return this.result(owner, id);
  }
  async close(owner: ChatOwner, id: string) {
    const c = this.conversation(owner, id);
    c.closed = true;
    c.blocked = true;
    this.store.putConversation(c);
    for (const p of this.pending.values())
      if (p.request.conversationId === id) this.cancel(owner, p.request.id);
    for (const [requestId, controller] of this.reconciliations)
      if (this.store.request(requestId)?.conversationId === id)
        controller.abort();
    await this.browser.close(id);
    return { closed: true };
  }
  reconcile(owner: ChatOwner, id: string, signal?: AbortSignal) {
    if (this.stopping) return Promise.reject(Error("bridge stopped"));
    if (this.reconciliations.has(id))
      return Promise.reject(Error("request busy"));
    const controller = new AbortController();
    this.reconciliations.set(id, controller);
    const timer = setTimeout(() => controller.abort(), 15_000);
    const task = this.performReconcile(
      owner,
      id,
      signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    ).finally(() => {
      clearTimeout(timer);
      this.reconciliations.delete(id);
    });
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
    return task;
  }
  private async performReconcile(
    owner: ChatOwner,
    id: string,
    signal: AbortSignal,
  ) {
    const r = this.request(owner, id);
    const c = this.conversation(owner, r.conversationId);
    if (this.maintenance.has(c.account)) throw Error("account in maintenance");
    if (r.state !== "unknown_submission") return this.result(owner, id);
    if (c.closed) throw Error("conversation closed");
    if (this.busy.has(c.account) || this.busy.size >= this.limits.global)
      throw Error("account busy");
    if (!this.browser.reconcile)
      return {
        ...this.result(owner, id),
        reconciliation: "unknown_submission",
      };
    this.busy.add(c.account);
    try {
      const found = await this.browser.reconcile(c, r, signal);
      if (found.state === "completed" && found.answer) {
        this.complete(r, found.answer);
        const current = this.conversation(owner, c.id);
        if (!current.closed) {
          current.blocked = false;
          this.store.putConversation(current);
        }
      }
      return { ...this.result(owner, id), reconciliation: found.state };
    } finally {
      this.busy.delete(c.account);
      this.pump();
    }
  }
  /** Called only by exclusive offline operator maintenance, never by tool/IPC dispatch. */
  resolve(owner: ChatOwner, id: string, decision: "sent" | "not_sent") {
    const r = this.request(owner, id);
    if (
      r.state !== "unknown_submission" ||
      this.pending.has(id) ||
      this.busy.has(r.audit.account)
    )
      throw Error("request not quiescent/uncertain");
    if (decision === "not_sent") {
      this.transition(r, "failed", "operator_attested_not_sent");
      const c = this.conversation(owner, r.conversationId);
      c.blocked = false;
      this.store.putConversation(c);
    } else {
      r.reason = "operator_attested_sent";
      this.store.putRequest(r);
    }
  }
  private block(id: string) {
    const c = this.store.conversation(id);
    if (c) {
      c.blocked = true;
      this.store.putConversation(c);
    }
  }
  private transition(
    r: ChatRequest,
    state: ChatRequest["state"],
    reason?: string,
  ) {
    r.state = state;
    r.reason = reason;
    r.updatedAt = this.now();
    this.store.putRequest(r);
    this.store.event(r);
  }
  private complete(r: ChatRequest, a: BrowserAnswer) {
    r.answer = a.text.slice(0, this.limits.answerChars);
    r.truncated = a.text.length > this.limits.answerChars;
    r.turnId = a.turnId;
    r.url = a.url;
    r.late = this.now() > r.deadlineAt;
    this.store.transaction(() => {
      const current = this.store.conversation(r.conversationId);
      if (current) {
        current.url = a.url;
        this.store.putConversation(current);
      }
      this.transition(r, "completed");
    });
  }
  private expire(id: string) {
    const p = this.pending.get(id);
    if (!p) return;
    this.transition(
      p.request,
      p.running ? "unknown_submission" : "failed",
      "deadline",
    );
    if (p.running) this.block(p.request.conversationId);
    p.controller.abort();
    if (!p.running) this.remove(p);
  }
  private remove(p: Pending) {
    clearTimeout(p.timer);
    p.prompt = "";
    this.pending.delete(p.request.id);
  }
  private pump() {
    if (this.stopping) return;
    for (const p of this.pending.values()) {
      if (
        p.running ||
        this.busy.size >= this.limits.global ||
        this.busy.has(p.request.audit.account)
      )
        continue;
      if (this.now() >= p.request.deadlineAt) {
        this.expire(p.request.id);
        continue;
      }
      p.running = true;
      this.busy.add(p.request.audit.account);
      const task = this.run(p);
      this.tasks.add(task);
      void task.then(
        () => this.tasks.delete(task),
        () => this.tasks.delete(task),
      );
    }
  }
  private async run(p: Pending) {
    const r = p.request;
    this.transition(r, "sending");
    try {
      const c = this.store.conversation(r.conversationId)!;
      const answer = await this.browser.run(
        c,
        p.prompt,
        p.controller.signal,
        (turnId, url, baseline) => {
          if (p.controller.signal.aborted) return;
          r.turnId = turnId;
          r.url = url;
          if (baseline) r.baseline = baseline;
          c.url = url;
          this.store.putConversation(c);
          this.transition(r, "waiting");
        },
        (baseline) => {
          if (!p.controller.signal.aborted) {
            r.baseline = baseline;
            this.store.putRequest(r);
          }
        },
      );
      if (p.controller.signal.aborted) return;
      this.complete(r, answer);
    } catch (e) {
      if (!p.controller.signal.aborted) {
        const safe = e instanceof BrowserFailure && e.beforeSubmission;
        this.transition(
          r,
          safe ? e.state : "unknown_submission",
          safe ? e.state : "browser_interrupted",
        );
        if (!safe) this.block(r.conversationId);
      }
    } finally {
      // A browser adapter must not return until its page actions have settled. Otherwise this slot stays fenced.
      this.busy.delete(r.audit.account);
      this.remove(p);
      this.pump();
    }
  }
  private purge() {
    const now = this.now();
    if (now - this.lastPurge < 1000) return;
    this.lastPurge = now;
    for (const r of this.store.requests()) {
      if (activeStates.has(r.state) || this.pending.has(r.id)) continue;
      if (r.answer !== undefined && now - r.updatedAt > 86_400_000) {
        r.answer = undefined;
        r.reason = "answer_expired";
        this.store.putRequest(r);
      }
    }
    // Expire the entire idle conversation with its keys: old IDs can never become a new send.
    for (const c of this.store.conversations()) {
      const requests = this.store
        .requests()
        .filter((r) => r.conversationId === c.id);
      if (
        requests.some(
          (r) =>
            activeStates.has(r.state) ||
            r.state === "unknown_submission" ||
            this.pending.has(r.id),
        )
      )
        continue;
      const last = Math.max(c.createdAt, ...requests.map((r) => r.updatedAt));
      if (now - last > 7 * 86_400_000) this.store.forgetConversation(c.id);
    }
  }
  shutdown(): Promise<void> {
    return (this.shutdownTask ??= (async () => {
      this.stopping = true;
      for (const controller of this.reconciliations.values())
        controller.abort();
      for (const p of [...this.pending.values()])
        this.cancel(p.request.owner, p.request.id);
      await Promise.all(
        [...this.pending.values()].map((p) =>
          this.browser.close(p.request.conversationId),
        ),
      );
      await Promise.allSettled(this.tasks);
      this.store.close();
    })());
  }
}

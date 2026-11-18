import { chromium, type BrowserContext, type Page } from "playwright";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { privateDirectory } from "./private-fs";
import { ADAPTERS, allowedPage, type Adapter } from "./adapters";
import {
  BrowserFailure,
  SERVICES,
  type BrowserAnswer,
  type BrowserRunner,
  type ChatAccount,
  type ChatConversation,
  type ChatRequest,
  type ReconcileResult,
  type TurnBaseline,
} from "./types";

export interface BrowserOptions {
  root: string;
  accounts: ChatAccount[];
  headless?: boolean;
  fixture?: { url: string; adapter: Adapter };
}
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export class BrowserManager implements BrowserRunner {
  private readonly contexts = new Map<string, Promise<BrowserContext>>();
  private readonly pages = new Map<string, Page>();
  private readonly closing = new Map<string, Promise<void>>();
  private readonly accounts: Map<string, ChatAccount>;
  private stopped = false;
  constructor(private readonly opts: BrowserOptions) {
    this.accounts = new Map(opts.accounts.map((a) => [a.id, a]));
    privateDirectory(opts.root);
  }
  get openPages() {
    return this.pages.size;
  }
  async finishLogin(account: string): Promise<void> {
    if (!this.accounts.has(account)) throw Error("unknown account");
    const pending = this.contexts.get(account);
    if (!pending) return;
    const context = await pending;
    await context.close();
    if (this.contexts.get(account) === pending) this.contexts.delete(account);
    for (const [id, page] of this.pages)
      if (page.isClosed()) this.pages.delete(id);
  }
  private adapter(c: ChatConversation) {
    return this.opts.fixture?.adapter ?? ADAPTERS[c.service];
  }
  private allowed(c: ChatConversation, url: string, login = false) {
    return this.opts.fixture
      ? new URL(url).origin === new URL(this.opts.fixture.url).origin
      : allowedPage(c.service, url, login);
  }
  private async context(accountId: string): Promise<BrowserContext> {
    if (this.stopped) throw Error("browser stopped");
    let context = this.contexts.get(accountId);
    if (context) return context;
    if (!this.accounts.has(accountId)) throw Error("unknown account");
    const profiles = privateDirectory(join(this.opts.root, "profiles")),
      profile = privateDirectory(join(profiles, accountId));
    context = chromium.launchPersistentContext(profile, {
      headless: this.opts.headless ?? false,
      acceptDownloads: false,
      chromiumSandbox: true,
      timeout: 5000,
    });
    this.contexts.set(accountId, context);
    try {
      return await context;
    } catch (e) {
      this.contexts.delete(accountId);
      throw e;
    }
  }
  private async page(c: ChatConversation, signal: AbortSignal): Promise<Page> {
    await this.closing.get(c.id);
    signal.throwIfAborted();
    let page = this.pages.get(c.id);
    if (page && !page.isClosed()) return page;
    const ctx = await this.context(c.account);
    signal.throwIfAborted();
    page = await ctx.newPage();
    this.pages.set(c.id, page);
    page.setDefaultTimeout(2000);
    page.setDefaultNavigationTimeout(5000);
    page.on("popup", (popup) => {
      void popup.close();
    });
    page.on("download", (download) => {
      void download.cancel();
    });
    await page.route("**/*", (route) => {
      const req = route.request();
      if (
        req.isNavigationRequest() &&
        !req.frame().parentFrame() &&
        !this.allowed(c, req.url(), true)
      )
        return route.abort();
      return route.continue();
    });
    const url = c.url ?? this.opts.fixture?.url ?? SERVICES[c.service];
    if (!this.allowed(c, url)) throw new BrowserFailure("unsupported_page");
    await page.goto(url, { waitUntil: "domcontentloaded" });
    return page;
  }
  private async state(page: Page, adapter: Adapter) {
    if (await page.locator(adapter.verification).count())
      throw new BrowserFailure("needs_verification");
    if (await page.locator(adapter.login).count())
      throw new BrowserFailure("needs_login");
    if (await page.locator(adapter.rateLimit).count())
      throw new BrowserFailure("rate_limited");
  }
  private async baseline(page: Page, a: Adapter): Promise<TurnBaseline> {
    return {
      userCount: await page.locator(a.user).count(),
      assistantCount: await page.locator(a.assistant).count(),
      url: page.url(),
    };
  }
  private async inspect(
    page: Page,
    a: Adapter,
    b: TurnBaseline,
    promptDigest: string,
  ): Promise<ReconcileResult> {
    const users = page.locator(a.user),
      assistants = page.locator(a.assistant);
    if (
      (await users.count()) !== b.userCount + 1 ||
      (await assistants.count()) > b.assistantCount + 1
    )
      return { state: "unknown_submission" };
    const user = users.nth(b.userCount);
    if (digest(await user.innerText()) !== promptDigest)
      return { state: "unknown_submission" };
    if ((await assistants.count()) !== b.assistantCount + 1)
      return { state: "still_generating" };
    const answer = assistants.nth(b.assistantCount);
    const ordered = await answer.evaluate((element, userSelector) => {
      const users = document.querySelectorAll(userSelector);
      const user = users[users.length - 1];
      return (
        !!user &&
        !!(
          user.compareDocumentPosition(element) &
          Node.DOCUMENT_POSITION_FOLLOWING
        )
      );
    }, a.user);
    if (!ordered) return { state: "unknown_submission" };
    const complete = await answer.evaluate(
      (el, selector) => el.matches(selector) || !!el.querySelector(selector),
      a.completed,
    );
    const generating = await answer.evaluate(
      (el, selector) => el.matches(selector) || !!el.querySelector(selector),
      a.generating,
    );
    if (!complete || generating) return { state: "still_generating" };
    if ((await answer.locator(a.answer).count()) !== 1)
      return { state: "unknown_submission" };
    const text = await answer
      .locator(a.answer)
      .evaluate((el) => (el as HTMLElement).innerText.slice(0, 128_001));
    if (!text.trim()) return { state: "unknown_submission" };
    const turnId =
      (await answer.getAttribute("data-message-id")) ??
      (await answer.getAttribute("data-id")) ??
      `assistant-${b.assistantCount}-${digest(text).slice(0, 16)}`;
    return { state: "completed", answer: { text, turnId, url: page.url() } };
  }
  async run(
    c: ChatConversation,
    prompt: string,
    signal: AbortSignal,
    submitted: (id: string, url: string, baseline?: TurnBaseline) => void,
    saveBaseline?: (b: TurnBaseline) => void,
  ): Promise<BrowserAnswer> {
    const abort = () => {
      void this.close(c.id);
    };
    signal.addEventListener("abort", abort, { once: true });
    let clicked = false;
    try {
      const page = await this.page(c, signal),
        a = this.adapter(c);
      await this.state(page, a);
      const b = await this.baseline(page, a);
      if (!c.url && (b.userCount !== 0 || b.assistantCount !== 0))
        throw new BrowserFailure("unsupported_page");
      if (
        (await page.locator(a.editor).count()) !== 1 ||
        (await page.locator(a.send).count()) !== 1
      )
        throw new BrowserFailure("unsupported_page");
      saveBaseline?.(b);
      await page.locator(a.editor).fill(prompt);
      const readback = await page.locator(a.editor).evaluate((el) => {
        if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)
          return el.value;
        // Chromium fill uses div/p blocks for logical lines. innerText adds
        // layout separators; textContent drops them. Preserve each line and
        // every literal whitespace character, including empty edge lines.
        const block = (node: Node) =>
          node instanceof HTMLElement && /^(DIV|P|LI)$/.test(node.tagName);
        const text = (node: Node): string => {
          if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
          if (node instanceof HTMLBRElement) return "\n";
          if (
            (node === el || block(node)) &&
            node.childNodes.length === 1 &&
            node.firstChild instanceof HTMLBRElement
          )
            return "";
          let result = "",
            previous: Node | undefined;
          for (const child of node.childNodes) {
            if (previous && (block(previous) || block(child))) result += "\n";
            result += text(child);
            previous = child;
          }
          return result;
        };
        return text(el);
      });
      if (readback !== prompt) throw new BrowserFailure("unsupported_page");
      signal.throwIfAborted();
      clicked = true;
      await page.locator(a.send).click();
      let observed = false;
      while (true) {
        signal.throwIfAborted();
        const current = await this.inspect(page, a, b, digest(prompt));
        if (!this.allowed(c, page.url()))
          throw new BrowserFailure("unsupported_page", false);
        if (current.state !== "unknown_submission" && !observed) {
          observed = true;
          submitted(`user-${b.userCount}`, page.url(), b);
        }
        if (current.state === "completed") return current.answer!;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    } catch (e) {
      if (e instanceof BrowserFailure) throw e;
      if (signal.aborted) throw signal.reason;
      throw new BrowserFailure("unsupported_page", !clicked);
    } finally {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) await this.close(c.id);
    }
  }
  async reconcile(
    c: ChatConversation,
    r: ChatRequest,
    signal: AbortSignal,
  ): Promise<ReconcileResult> {
    if (!r.baseline || !c.url || !this.allowed(c, c.url))
      return { state: "unknown_submission" };
    const abort = () => {
      void this.close(c.id);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const page = await this.page(c, signal);
      signal.throwIfAborted();
      return await this.inspect(
        page,
        this.adapter(c),
        r.baseline,
        r.audit.promptDigest,
      );
    } catch {
      return { state: "unknown_submission" };
    } finally {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) await this.close(c.id);
    }
  }
  async login(account: string): Promise<BrowserContext> {
    return this.context(account);
  }
  close(id: string): Promise<void> {
    const existing = this.closing.get(id);
    if (existing) return existing;
    const page = this.pages.get(id);
    if (!page) return Promise.resolve();
    this.pages.delete(id);
    const task = page
      .close()
      .catch(() => {})
      .finally(() => this.closing.delete(id));
    this.closing.set(id, task);
    return task;
  }
  async shutdown() {
    this.stopped = true;
    await Promise.allSettled([
      ...this.closing.values(),
      ...[...this.contexts.values()].map(async (p) => (await p).close()),
    ]);
    this.contexts.clear();
    this.pages.clear();
  }
}

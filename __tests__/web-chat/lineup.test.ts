import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTERS, allowedPage } from "../../src/web-chat/adapters";
import { BrowserProcess } from "../../src/web-chat/browser-process";
import { WebChatService } from "../../src/web-chat/service";
import { ADAPTER_VERSION } from "../../src/web-chat/types";
import type {
  BrowserRunner,
  ChatConversation,
  ChatService,
} from "../../src/web-chat/types";

const roots: string[] = [];
const browsers: BrowserProcess[] = [];
const services: WebChatService[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
const root = () => {
  const path = mkdtempSync(join(tmpdir(), "webchat-lineup-"));
  roots.push(path);
  return path;
};
const browser: BrowserRunner = {
  run: async () => {
    throw Error("unverified account must never send");
  },
  close: async () => {},
};
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown();
  for (const manager of browsers.splice(0)) await manager.shutdown();
  for (const server of servers.splice(0)) await server.stop(true);
  for (const path of roots.splice(0))
    rmSync(path, { recursive: true, force: true });
});

test("SC-2 regression: requested accounts are admitted but unverified creates are forbidden", () => {
  const accounts = ["claude", "chatgpt", "grok", "gemini"].map((service) => ({
    id: service,
    service: service as ChatService,
  }));
  const service = new WebChatService({ root: root(), accounts, browser });
  services.push(service);
  expect(service.list().map((account) => account.service)).toEqual([
    "claude",
    "chatgpt",
    "grok",
    "gemini",
  ]);
  for (const account of accounts) {
    expect(
      service.list().find((a) => a.account === account.id)?.available,
    ).toBe(false);
    expect(() =>
      service.create({ agent: "test", session: "test" }, account.id),
    ).toThrow("unverified");
  }
});

test("SC-2 regression: send rechecks service binding on an existing conversation", () => {
  const account = {
    id: "bound",
    service: "claude" as const,
    validatedVersion: ADAPTER_VERSION,
    validatedService: "claude" as ChatService,
  };
  const service = new WebChatService({
    root: root(),
    accounts: [account],
    browser,
  });
  services.push(service);
  const owner = { agent: "fixture", session: "s" };
  const conversation = service.create(owner, account.id);
  expect(service.list()[0]?.available).toBe(true);
  account.validatedService = "grok";
  expect(() =>
    service.send(owner, {
      conversationId: conversation.id,
      retryKey: "do-not-send",
      prompt: "public prompt",
    }),
  ).toThrow("unverified");
});

for (const name of ["deepseek", "qwen", "unknown", "toString", "__proto__"])
  test(`SC-2: unsupported service ${name} cannot reuse a profile as another service`, () => {
    expect(
      () =>
        new WebChatService({
          root: root(),
          accounts: [
            {
              id: "old-profile",
              service: name as ChatService,
              validatedVersion: "web-chat-1",
            },
          ],
          browser,
        }),
    ).toThrow("invalid account");
  });

for (const name of ["claude", "chatgpt", "grok", "gemini"] as const)
  for (const previous of [undefined, "deepseek"] as const)
    test(`SC-2 regression: ${name} refuses legacy or relabeled ${previous ?? "unbound"} validation`, () => {
      const service = new WebChatService({
        root: root(),
        accounts: [
          {
            id: "old-profile",
            service: name,
            validatedVersion: ADAPTER_VERSION,
            validatedService: previous as ChatService | undefined,
          },
        ],
        browser,
      });
      services.push(service);
      expect(service.list()[0]?.available).toBe(false);
      expect(() =>
        service.create({ agent: "fixture", session: "s" }, "old-profile"),
      ).toThrow("unverified");
    });

for (const [service, url] of [
  ["claude", "https://claude.ai/new"],
  ["grok", "https://grok.com/"],
] as const) {
  test(`SC-3: ${service} navigation stays on the intended HTTPS host`, () => {
    expect(allowedPage(service, url)).toBe(true);
    expect(allowedPage(service, url.replace("https:", "http:"))).toBe(false);
    expect(
      allowedPage(
        service,
        url.replace(
          new URL(url).hostname,
          `${new URL(url).hostname}.evil.test`,
        ),
        true,
      ),
    ).toBe(false);
    expect(allowedPage(service, "https://accounts.google.com/", true)).toBe(
      false,
    );
  });

  for (const complete of [true, false])
    test(`SC-3: ${service} candidate contract ${complete ? "accepts a new completed pair" : "refuses missing completion evidence"}`, async () => {
      expect(ADAPTERS[service]).toBeDefined();
      // Deliberate local DOM contracts, NOT a recording or claim about today's website.
      const editor =
        service === "claude"
          ? '<div class="ProseMirror" contenteditable="true"></div>'
          : "<textarea></textarea>";
      let assistantReady!: () => void;
      const ready = new Promise<void>((resolve) => {
        assistantReady = resolve;
      });
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: (request) => {
          if (new URL(request.url).pathname === "/assistant-ready") {
            assistantReady();
            return new Response("ok");
          }
          return new Response(
            `${editor}<button type="submit" aria-label="Send message">Send</button>
          <script>
          document.querySelector('button').onclick=()=>{
            const editor=document.querySelector('textarea, [contenteditable]');
            const prompt=editor.value ?? editor.innerText;
            const user=document.createElement('div');
            user.dataset.testid='user-message'; user.dataset.role='user'; user.textContent=prompt;
            document.body.append(user);
            setTimeout(()=>{
              const answer=document.createElement('div');
              answer.dataset.testid='assistant-message'; answer.dataset.role='assistant';
              ${complete ? "answer.dataset.messageStatus='complete';" : ""}
              const body=document.createElement('div');
              body.className='font-claude-response'; body.dataset.testid='message-content'; body.textContent=prompt;
              answer.append(body); document.body.append(answer);
              fetch('/assistant-ready', {method:'POST'});
            },60);
          };
          </script>`,
            { headers: { "content-type": "text/html" } },
          );
        },
      });
      servers.push(server);
      const manager = new BrowserProcess({
        root: root(),
        accounts: [{ id: service, service }],
        headless: true,
        fixture: { url: server.url.href, adapter: ADAPTERS[service] },
      });
      browsers.push(manager);
      const conversation: ChatConversation = {
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        owner: { agent: "fixture", session: "s" },
        account: service,
        service,
        closed: false,
        blocked: false,
      };
      let submitted = 0;
      let sawSubmission!: () => void;
      const submission = new Promise<void>((resolve) => {
        sawSubmission = resolve;
      });
      const prompt = "a new exact turn";
      const controller = new AbortController();
      let settled = false;
      const result = manager.run(
        conversation,
        prompt,
        AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
        () => {
          submitted++;
          sawSubmission();
        },
      );
      void result.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      if (complete) {
        expect((await result).text).toBe(prompt);
      } else {
        // Startup time is not the missing-completion signal: prove that the
        // actual submitted turn and nonempty assistant exist before aborting.
        await Promise.race([
          Promise.all([submission, ready]),
          Bun.sleep(10000).then(() => {
            throw Error("fixture turn was not observed");
          }),
        ]);
        expect(submitted).toBe(1);
        await Bun.sleep(200);
        expect(settled).toBe(false);
        controller.abort();
        await expect(result).rejects.toThrow("browser interrupted");
        expect(manager.openPages).toBe(0);
      }
      expect(submitted).toBe(1);
    }, 15000);
}

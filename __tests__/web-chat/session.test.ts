import { seatbeltTest } from "../helpers/seatbelt";
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "../../src/agents/session";
import { JsonlStore } from "../../src/memory/jsonl-store";
import { BrowserProcess as BrowserManager } from "../../src/web-chat/browser-process";
import { fixtureAdapter } from "../../src/web-chat/adapters";
import { WebChatService } from "../../src/web-chat/service";
import { startIpc } from "../../src/web-chat/ipc";
import { WebChatClient } from "../../src/web-chat/client";
import {
  createToolBoundary,
  installToolBoundary,
} from "../../src/web-chat/tool-boundary";
import type { Provider, ProviderRequest } from "../../src/providers/interface";
import type { LoadedAgent } from "../../src/agents/loader";
for (const stream of [false, true])
  seatbeltTest(`WB-1: real AgentSession ${stream ? "stream" : "query"} -> Unix IPC -> Chromium -> same-session result`, async () => {
    const root = mkdtempSync(join(tmpdir(), "webchat-session-")),
      privateRoot = join(root, "private"),
      room = join(root, "room");
    mkdirSync(room);
    const home = process.env.HOME,
      browserPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
    process.env.PLAYWRIGHT_BROWSERS_PATH =
      browserPath ?? join(home!, "Library/Caches/ms-playwright");
    process.env.HOME = root;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response(
          readFileSync(join(import.meta.dir, "fixtures/chat.html")),
          { headers: { "content-type": "text/html" } },
        ),
    });
    const browser = new BrowserManager({
      root: privateRoot,
      accounts: [{ id: "gpt", service: "chatgpt" }],
      headless: true,
      fixture: { url: server.url.href, adapter: fixtureAdapter },
    });
    const service = new WebChatService({
      root: privateRoot,
      accounts: [
        {
          id: "gpt",
          service: "chatgpt",
          validatedVersion: "test",
          validatedService: "chatgpt" as const,
        },
      ],
      adapterVersion: "test",
      browser,
    });
    const key = crypto.getRandomValues(new Uint8Array(32)),
      ipc = await startIpc({ root: privateRoot, key, service });
    const client = new WebChatClient(ipc.socket, key);
    let registrations = 0;
    const call = client.call.bind(client);
    client.call = async (...args) => {
      if (args[1].operation === "register_private") registrations++;
      return call(...args);
    };
    installToolBoundary(await createToolBoundary([privateRoot], []));
    const owner = { agent: "fixture", session: "session-verified" };
    const received: ProviderRequest[] = [];
    let requestId = "";
    let conversationId = "";
    const next = (req: ProviderRequest) => {
      received.push(req);
      const last = req.messages.at(-1);
      let args: object;
      if (last?.role === "tool") {
        const data = JSON.parse(String(last.content));
        if (data.result?.account && !data.result?.state)
          conversationId = data.result.id;
        else if (data.result?.id) requestId = data.result.id;
        if (data.result?.state === "completed")
          return {
            message: {
              role: "assistant" as const,
              content: "received " + data.result.answer,
            },
          };
        if (
          data.result?.state &&
          !["queued", "sending", "waiting"].includes(data.result.state)
        )
          throw Error(
            "fixture terminal state " +
              data.result.state +
              ": " +
              data.result.reason,
          );
        args = requestId
          ? { operation: "result", requestId }
          : {
              operation: "send",
              conversationId,
              retryKey: "once",
              prompt: "only this requested question",
            };
      } else args = { operation: "create", account: "gpt" };
      return {
        message: { role: "assistant" as const, content: "poll" },
        tool_calls: [
          {
            id: crypto.randomUUID(),
            name: "anima_web_chat",
            arguments: JSON.stringify(args),
          },
        ],
      };
    };
    const provider: Provider = {
      name: "fixture-api",
      sharedSafe: true,
      query: stream
        ? (req) =>
            (async function* () {
              await Bun.sleep(30);
              const response = next(req);
              if (response.tool_calls)
                yield {
                  type: "tool_call" as const,
                  tool_call: response.tool_calls[0],
                };
              else
                yield {
                  type: "text" as const,
                  content: response.message.content,
                };
            })()
        : async (req) => {
            await Bun.sleep(30);
            return next(req);
          },
    };
    const agent = {
      name: "fixture",
      label: "Fixture",
      roomDir: room,
      geneContent: "PRIVATE BOOT unique text never in requested prompt",
      soulContent: "private identity",
      sessionContextFiles: [],
      additionalContent: [],
      config: {
        identity: { name: "fixture", label: "Fixture" },
        provider: { type: "fixture-api" },
        policy: { allowedRoots: [room], allowedTools: ["anima_web_chat"] },
        session: {
          defaultMode: "plan",
          autoModeOptIn: false,
          compactThreshold: 0,
        },
        boot: { gene: "GENE.md", soul: "SOUL.md", sessionContext: [] },
      },
    } as LoadedAgent;
    try {
      const session = new AgentSession({
        store: new JsonlStore(root),
        provider,
        webChatClient: client,
        log: () => {},
      });
      let text = "";
      if (stream) {
        for await (const chunk of session.runStream({
          agent,
          message: "ask",
          sessionId: owner.session,
          continuityDbPath: join(root, "continuity.db"),
        }))
          if (chunk.type === "text") text += chunk.content;
      } else {
        const result = await session.run({
          agent,
          message: "ask",
          sessionId: owner.session,
          continuityDbPath: join(root, "continuity.db"),
        });
        text = JSON.stringify(result);
      }
      expect(text).toContain("received OK");
      expect(service.result(owner, requestId)).toMatchObject({
        owner,
        conversationId,
      });
      expect(service.result(owner, requestId).audit.promptLength).toBe(28);
      expect(() =>
        service.result({ agent: "fixture", session: "forged" }, requestId),
      ).toThrow("owner");
      expect(registrations).toBe(2);
      requestId = "";
      conversationId = "";
      const again = {
        agent,
        message: "ask again",
        sessionId: owner.session,
        continuityDbPath: join(root, "continuity.db"),
      };
      if (stream) {
        for await (const _ of session.runStream(again)) {
        }
      } else await session.run(again);
      expect(registrations).toBe(2);
    } finally {
      installToolBoundary(undefined);
      await ipc.close();
      await browser.shutdown();
      await server.stop(true);
      process.env.HOME = home;
      if (browserPath === undefined)
        delete process.env.PLAYWRIGHT_BROWSERS_PATH;
      else process.env.PLAYWRIGHT_BROWSERS_PATH = browserPath;
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);

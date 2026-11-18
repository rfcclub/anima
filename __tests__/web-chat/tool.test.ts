import { seatbeltTest } from "../helpers/seatbelt";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildToolDefinitions } from "../../src/tools/definitions";
import { executeTool } from "../../src/tools/executor";
import {
  createToolBoundary,
  installToolBoundary,
} from "../../src/web-chat/tool-boundary";
const roots: string[] = [];
afterEach(() => {
  installToolBoundary(undefined);
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const call = (args: object, name = "anima_web_chat") => ({
  id: "1",
  name,
  arguments: JSON.stringify(args),
});
seatbeltTest("WB-3/WB-10: explicit permission, trusted owner/signal, forged field denial", async () => {
  const seen: any[] = [];
  const client = {
    call: async (...args: any[]) => {
      seen.push(args);
      return { answer: "<script>untrusted</script>", usage: null };
    },
  } as any;
  const opts = {
    agentName: "finn",
    sessionId: "trusted-s",
    webChatClient: client,
    policy: {
      allowedRoots: [],
      allowedTools: ["anima_web_chat"],
      enforce: "off" as const,
    },
  };
  expect(buildToolDefinitions(["anima_web_chat"])[0]?.name).toBe(
    "anima_web_chat",
  );
  expect(
    await executeTool(call({ operation: "list" }), { ...opts, policy: null }),
  ).toContain("explicit");
  expect(
    await executeTool(call({ operation: "list" }), {
      ...opts,
      sessionId: undefined,
    }),
  ).toContain("identity");
  expect(
    await executeTool(
      call({ operation: "list", owner: { agent: "other", session: "s" } }),
      opts,
    ),
  ).toContain("fields");
  const root = mkdtempSync(join(tmpdir(), "webchat-tool-"));
  roots.push(root);
  installToolBoundary(await createToolBoundary([root], []));
  const controller = new AbortController();
  const result = await executeTool(call({ operation: "list" }), {
    ...opts,
    signal: controller.signal,
  });
  expect(result).toContain("untrusted");
  expect(seen).toHaveLength(1);
  expect(seen[0][0]).toEqual({ agent: "finn", session: "trusted-s" });
  expect(seen[0][2]).toBe(controller.signal);
});
seatbeltTest("WB-4: file and shell tools obey private roots in warn/off modes", async () => {
  const root = mkdtempSync(join(tmpdir(), "webchat-harddeny-"));
  roots.push(root);
  const secret = join(root, "secret");
  writeFileSync(secret, "private-marker");
  const alias = join(root, "alias");
  symlinkSync(secret, alias);
  installToolBoundary(await createToolBoundary([secret], []));
  for (const enforce of ["off", "warn"] as const) {
    const opts = { cwd: root, policy: { allowedRoots: [root], enforce } };
    expect(await executeTool(call({ path: alias }, "read"), opts)).toContain(
      "private",
    );
    expect(
      await executeTool(call({ command: `cat '${alias}'` }, "bash"), opts),
    ).not.toContain("private-marker");
  }
});

seatbeltTest("WB-4: native SDK carrier fails closed while bridge boundary is active", async () => {
  const root = mkdtempSync(join(tmpdir(), "webchat-native-"));
  roots.push(root);
  installToolBoundary(await createToolBoundary([root], []));
  const p = Bun.spawn(
    [process.execPath, join(import.meta.dir, "fixtures/native-guard.ts"), root],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(await new Response(p.stdout).text()).toContain("native tool carriers");
  expect(await p.exited).toBe(0);
});

seatbeltTest("WB-4: boot actions and reviewer helpers cannot become private-file read proxies", async () => {
  const root = mkdtempSync(join(tmpdir(), "webchat-proxies-"));
  roots.push(root);
  const secret = join(root, "secret");
  writeFileSync(secret, "private-marker");
  installToolBoundary(await createToolBoundary([secret], []));
  const { AgentLoader } = await import("../../src/agents/loader");
  const loader = new AgentLoader({ roomsDir: root });
  const boot = await (loader as any)
    .readBootFile("fixture", root, secret)
    .catch((e: any) => String(e.cause ?? e));
  expect(boot).not.toContain("private-marker");
  const actions = await (loader as any).runExtraActions(
    { boot: { extraActions: [{ label: "probe", run: `cat '${secret}'` }] } },
    root,
  );
  expect(actions[0].stdout).not.toContain("private-marker");
  const { ReviewerAgent } = await import("../../src/agents/reviewer");
  const reviewer = new ReviewerAgent({
    output: "",
    domain: "code",
    agentId: "fixture",
    cwd: root,
    cartridgeLoader: {} as any,
    cartridgeRegistry: {} as any,
  });
  await expect((reviewer as any).toolAccess.read("secret")).rejects.toThrow(
    "private",
  );
  expect(
    (await (reviewer as any).toolAccess.bash("cat secret")).stdout,
  ).not.toContain("private-marker");
});

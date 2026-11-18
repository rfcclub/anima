import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const EXPECTED_MESH_TOOLS = [
  "mesh_send",
  "mesh_agents",
  "mesh_agent_send",
  "mesh_peek",
  "mesh_pull",
  "mesh_ack",
  "mesh_status",
  "mesh_thread",
  "mesh_subscribe",
  "mesh_unsubscribe",
  "mesh_register_recipient",
  "mesh_unregister_recipient",
] as const;

export interface RuntimeMcpConfig {
  runtime: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  source?: string;
}

export function validateRuntimeConfigs(configs: RuntimeMcpConfig[]): string[] {
  const errors: string[] = [];
  const identities = new Map<string, string>();
  for (const config of configs) {
    if (!config.command) errors.push(`${config.runtime}: missing command`);
    const id = config.env.MESH_INSTANCE_ID;
    const platform = config.env.MESH_PLATFORM;
    if (!id) {
      errors.push(`${config.runtime}: missing MESH_INSTANCE_ID`);
      continue;
    }
    if (!platform) {
      errors.push(`${config.runtime}: missing MESH_PLATFORM`);
      continue;
    }
    if (id.startsWith("cli-") || id.startsWith("codex-") || id.startsWith("anima-")) {
      errors.push(`${config.runtime}: MESH_INSTANCE_ID must be a bare id, got ${id}`);
    }
    const identity = `${id}/${platform}`;
    const owner = identities.get(identity);
    if (owner) errors.push(`${config.runtime} and ${owner} share mesh identity ${identity}`);
    else identities.set(identity, config.runtime);
  }
  return errors;
}

export function parseSnippet(path: string, runtime: string): RuntimeMcpConfig {
  const text = readFileSync(path, "utf8");
  const command = matchValue(text, /command\s*[:=]\s*["']([^"']+)["']/);
  const id = matchValue(text, /MESH_INSTANCE_ID\s*[:=]\s*["']([^"']+)["']/);
  const platform = matchValue(text, /MESH_PLATFORM\s*[:=]\s*["']([^"']+)["']/);
  const argsMatch = text.match(/args\s*[:=]\s*\[([^\]]*)\]/s);
  const args = argsMatch
    ? [...argsMatch[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1])
    : [];
  return {
    runtime,
    command: command ?? "",
    args,
    env: {
      ...(id ? { MESH_INSTANCE_ID: id } : {}),
      ...(platform ? { MESH_PLATFORM: platform } : {}),
    },
    source: path,
  };
}

function matchValue(text: string, regex: RegExp): string | undefined {
  return text.match(regex)?.[1];
}

export async function mcpExchange(options: {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  requests: unknown[];
  timeoutMs?: number;
}): Promise<any[]> {
  const proc = Bun.spawn([options.command, ...(options.args ?? [])], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...(options.env ?? {}) },
  });

  const responses: any[] = [];
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;
  const pump = (async () => {
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        responses.push(JSON.parse(line));
      }
    }
  })();

  for (const request of options.requests) {
    proc.stdin.write(JSON.stringify(request) + "\n");
  }

  const deadline = Date.now() + (options.timeoutMs ?? 5_000);
  while (responses.length < options.requests.length && Date.now() < deadline) {
    await Bun.sleep(25);
  }

  done = true;
  proc.stdin.end();
  await Promise.race([proc.exited, Bun.sleep(1_000)]);
  proc.kill();
  await pump.catch(() => {});
  return responses.filter((response) => response.id !== undefined);
}

export async function listToolsViaMcp(config: RuntimeMcpConfig): Promise<string[]> {
  const responses = await mcpExchange({
    command: config.command,
    args: config.args,
    env: config.env,
    requests: [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ],
  });
  const tools = responses.find((response) => response.id === 2)?.result?.tools ?? [];
  return tools.map((tool: { name: string }) => tool.name);
}

export interface McpRoundTripResult {
  ok: boolean;
  pullText: string;
  ackText: string;
}

export async function runMcpRoundTripDetails(config: RuntimeMcpConfig, recipientId = "mcp-roundtrip-recipient", recipientPlatform = platformFromInstanceId(recipientId)): Promise<McpRoundTripResult> {
  const threadId = `mcp-runtime-usage-${Date.now()}`;
  const content = `mcp runtime usage ${threadId}`;
  const responses = await mcpExchange({
    command: config.command,
    args: config.args,
    env: config.env,
    requests: [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mesh_register_recipient", arguments: { instance_id: recipientId, platform: recipientPlatform } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "mesh_send", arguments: { to_id: recipientId, to_platform: recipientPlatform, content, thread_id: threadId } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "mesh_pull", arguments: { instance_id: recipientId, platform: recipientPlatform, thread_id: threadId } } },
    ],
  });
  const pullText = responses.find((response) => response.id === 4)?.result?.content?.[0]?.text ?? "";
  const deliveryId = Number(pullText.match(/delivery_id:\s*(\d+)/)?.[1]);
  const claimToken = pullText.match(/claim_token:\s*([a-f0-9-]+)/)?.[1];
  if (!deliveryId || !claimToken || !pullText.includes(content)) {
    return { ok: false, pullText, ackText: "" };
  }

  const ackResponses = await mcpExchange({
    command: config.command,
    args: config.args,
    env: config.env,
    requests: [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "mesh_ack", arguments: { instance_id: recipientId, platform: recipientPlatform, delivery_id: deliveryId, claim_token: claimToken } } },
    ],
  });
  const ackText = ackResponses.find((response) => response.id === 5)?.result?.content?.[0]?.text ?? "";
  return { ok: ackText.includes("Acked delivery"), pullText, ackText };
}

function platformFromInstanceId(instanceId: string): string {
  const prefix = instanceId.split("-")[0];
  return ["cc", "oc", "anima", "codex", "gemini", "qwen", "reasonix", "hermes", "agy"].includes(prefix)
    ? prefix
    : "test";
}

export async function runMcpRoundTrip(config: RuntimeMcpConfig, recipientId = "mcp-roundtrip-recipient"): Promise<boolean> {
  return (await runMcpRoundTripDetails(config, recipientId)).ok;
}

export function ensureReadOnlyMode(apply: boolean): void {
  if (apply) throw new Error("--apply is not implemented for this change; validation is read-only");
}

export function configForInstalledCommand(runtime = "codex", instanceId = "agent-a", platform = "codex"): RuntimeMcpConfig {
  return { runtime, command: "colony-mesh", args: [], env: { MESH_INSTANCE_ID: instanceId, MESH_PLATFORM: platform } };
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (import.meta.main) {
  ensureReadOnlyMode(process.argv.includes("--apply"));
  const command = argValue("--command") ?? "colony-mesh";
  const runtime = argValue("--runtime") ?? "codex";
  const instanceId = argValue("--instance-id") ?? "agent-a";
  const platform = argValue("--platform") ?? "codex";
  const home = argValue("--home");
  const script = argValue("--script");
  if (command === "bun" && !script) {
    console.error("--command bun needs --script <path to the colony-mesh entry script>");
    process.exit(2);
  }
  if (home) mkdirSync(join(home, "substrate"), { recursive: true });
  const config: RuntimeMcpConfig = {
    runtime,
    command,
    args: command === "bun" ? [script!] : [],
    env: { MESH_INSTANCE_ID: instanceId, MESH_PLATFORM: platform, ...(home ? { HOME: home } : {}) },
  };
  const errors = validateRuntimeConfigs([config]);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(2);
  }
  const tools = await listToolsViaMcp(config);
  console.log(JSON.stringify({ runtime, instanceId, platform, tools }, null, 2));
}

import type { IdentityRuntimeClient } from "../../packages/identity-runtime/src/transport.ts";
import { IdentityRuntimeClient as RuntimeClient } from "../../packages/identity-runtime/src/transport.ts";

/** Codex lifecycle hook: must run before model invocation. */
export function beginCodexTurn(client: IdentityRuntimeClient) {
  return client.join("codex");
}

/** Executes the model-facing hook only after the authoritative projection is joined. */
export async function runCodexTurn<T>(
  client: IdentityRuntimeClient,
  invoke: (input: { system: string; identityRuntime: IdentityRuntimeClient }) => Promise<T>,
): Promise<T> {
  const joined = await beginCodexTurn(client);
  return invoke({ system: joined.projection, identityRuntime: client });
}

/** Reads local Codex configuration and fails closed for an opted-in surface. */
export function createCodexIdentityRuntimeClient(input: {
  agentId: string;
  clientId?: string;
  env?: Record<string, string | undefined>;
}): IdentityRuntimeClient {
  const env = input.env ?? process.env;
  const endpoint = env.IDENTITY_RUNTIME_ENDPOINT;
  const bootstrapToken = env.IDENTITY_RUNTIME_BOOTSTRAP_TOKEN;
  if (!endpoint || !bootstrapToken) {
    throw new Error("Codex identity runtime is enabled but IDENTITY_RUNTIME_ENDPOINT and IDENTITY_RUNTIME_BOOTSTRAP_TOKEN are required");
  }
  return new RuntimeClient({ endpoint, agentId: input.agentId, clientId: input.clientId ?? "codex", bootstrapToken });
}

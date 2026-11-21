import { test, expect } from "bun:test";
import { withDefaultModel } from "./default-model";
import type { Provider, ProviderRequest, ProviderResponse } from "./interface";

function spy(): { provider: Provider; seen: ProviderRequest[] } {
  const seen: ProviderRequest[] = [];
  const provider: Provider = {
    name: "fake" as Provider["name"],
    sharedSafe: true,
    async query(req: ProviderRequest): Promise<ProviderResponse> {
      seen.push(req);
      return { message: { role: "assistant", content: "ok" } };
    },
  };
  return { provider, seen };
}

const req = (model?: string): ProviderRequest => ({
  agent: "lena",
  messages: [{ role: "user", content: "hi" }],
  mode: "plan",
  model,
});

test("fills in the room's model when the request names none", async () => {
  const { provider, seen } = spy();
  await withDefaultModel(provider, "room-model").query(req());
  expect(seen[0]!.model).toBe("room-model");
});

test("keeps a model the request names itself", async () => {
  const { provider, seen } = spy();
  await withDefaultModel(provider, "room-model").query(req("explicit"));
  expect(seen[0]!.model).toBe("explicit");
});

test("keeps the provider's name and sharedSafe flag", () => {
  const { provider } = spy();
  const wrapped = withDefaultModel(provider, "room-model");
  expect(wrapped.name).toBe("fake" as Provider["name"]);
  expect(wrapped.sharedSafe).toBe(true);
});

test("keeps the metered marker so the wrapper is not metered twice", () => {
  const { provider } = spy();
  (provider as unknown as Record<symbol, unknown>)[Symbol.for("anima.metered")] = true;
  const wrapped = withDefaultModel(provider, "room-model");
  expect((wrapped as unknown as Record<symbol, unknown>)[Symbol.for("anima.metered")]).toBe(true);
});

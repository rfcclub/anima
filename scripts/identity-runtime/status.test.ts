import { expect, test } from "bun:test";
import { fetchHealth, formatStatus } from "./status.ts";

test("formatStatus reports no tenants registered", () => {
  expect(formatStatus({ ok: true, runtime: "identity-runtime", tenants: [] })).toBe("no tenants registered");
});

test("formatStatus lists each tenant with no flag when clean", () => {
  const output = formatStatus({
    ok: true,
    runtime: "identity-runtime",
    tenants: [{ agentId: "bruno", pendingMutations: 0 }, { agentId: "eli", pendingMutations: 0 }],
  });
  expect(output).toBe("bruno: pendingMutations=0\neli: pendingMutations=0");
});

test("formatStatus flags a tenant with pending mutations and points at the recovery command", () => {
  const output = formatStatus({
    ok: true,
    runtime: "identity-runtime",
    tenants: [{ agentId: "bruno", pendingMutations: 2 }],
  });
  expect(output).toBe(
    "bruno: pendingMutations=2 ⚠ needs recovery: bun scripts/identity-runtime/recover-mutations.ts list bruno",
  );
});

test("fetchHealth calls /health on the given origin and returns the parsed body", async () => {
  const calls: string[] = [];
  const fakeFetch = (async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify({ ok: true, runtime: "identity-runtime", tenants: [] }), { status: 200 });
  }) as typeof fetch;

  const health = await fetchHealth("http://127.0.0.1:13541", fakeFetch);

  expect(calls).toEqual(["http://127.0.0.1:13541/health"]);
  expect(health).toEqual({ ok: true, runtime: "identity-runtime", tenants: [] });
});

test("fetchHealth throws with the status code on a non-OK response", async () => {
  const fakeFetch = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;

  await expect(fetchHealth("http://127.0.0.1:13541", fakeFetch)).rejects.toThrow("503");
});

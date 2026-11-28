import { describe, expect, test } from "bun:test";
import { ProviderError, type Provider, type ProviderRequest, type ProviderResponse } from "../../src/providers/interface";
import { withFallback } from "../../src/work/provider-fallback";

const req = { messages: [{ role: "user", content: "hi" }] } as unknown as ProviderRequest;
const answer = (text: string): ProviderResponse => ({ message: { role: "assistant", content: text } } as unknown as ProviderResponse);
function failing(code: ConstructorParameters<typeof ProviderError>[0]): Provider & { calls: number } {
  const p = { name: "primary", calls: 0, query() { p.calls++; return Promise.reject(new ProviderError(code, "primary", code)); } };
  return p as never;
}
function ok(text: string): Provider & { calls: number } {
  const p = { name: "fallback", calls: 0, query() { p.calls++; return Promise.resolve(answer(text)); } };
  return p as never;
}

describe("work provider fallback", () => {
  test.each(["RATE_LIMITED", "QUOTA_EXHAUSTED", "SERVER_ERROR", "TIMEOUT"] as const)("a %s from the pinned provider is answered by the fallback", async (code) => {
    const seen: string[] = [];
    const fb = ok("from fallback");
    const r = await withFallback(failing(code), fb, (e) => seen.push(e.code)).query(req) as ProviderResponse;
    expect(r.message.content).toBe("from fallback");
    expect(fb.calls).toBe(1);
    expect(seen).toEqual([code]);
  });

  test("an authentication error is not hidden by the fallback", async () => {
    const fb = ok("x");
    await expect(Promise.resolve(withFallback(failing("AUTH_ERROR"), fb).query(req))).rejects.toThrow("AUTH_ERROR");
    expect(fb.calls).toBe(0);
  });

  test("without a fallback the pinned provider is returned unchanged", () => {
    const p = failing("RATE_LIMITED");
    expect(withFallback(p, undefined)).toBe(p);
  });

  test("an aborted request does not fall back", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const fb = ok("x");
    await expect(Promise.resolve(withFallback(failing("TIMEOUT"), fb).query({ ...req, signal: ctrl.signal } as ProviderRequest))).rejects.toThrow("TIMEOUT");
    expect(fb.calls).toBe(0);
  });

  test("a streamed answer falls back only before its first chunk", async () => {
    const early: Provider = { name: "p", async *query() { throw new ProviderError("RATE_LIMITED", "p", "busy"); } };
    const late: Provider = { name: "p", async *query() { yield { type: "text", text: "partial" } as never; throw new ProviderError("SERVER_ERROR", "p", "cut"); } };
    const fbStream: Provider = { name: "f", async *query() { yield { type: "text", text: "fallback" } as never; } };
    const collect = async (p: Provider) => { const out: unknown[] = []; for await (const c of p.query(req) as AsyncGenerator<unknown>) out.push(c); return out; };
    expect(await collect(withFallback(early, fbStream))).toEqual([{ type: "text", text: "fallback" }]);
    await expect(collect(withFallback(late, fbStream))).rejects.toThrow("cut");
  });
});

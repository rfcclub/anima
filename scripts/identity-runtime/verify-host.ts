/** Portable HTTP-only verification. Run with Bun on the host being verified. */
export interface VerifyHostOptions {
  origin: string;
  tenant: string;
  writeProbe?: boolean;
  token?: string;
  timeoutMs?: number;
  pollAttempts?: number;
  pollIntervalMs?: number;
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
}

interface Check { name: string; status: "pass" | "fail" | "skip"; code?: string }
export interface HostVerification { ok: boolean; complete: boolean; checks: Check[] }
class ProbeFailure extends Error {}
const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export async function verifyHost(options: VerifyHostOptions): Promise<HostVerification> {
  const checks: Check[] = [];
  let stage = "configuration";
  const fail = (code: string): never => { throw new ProbeFailure(code); };
  try {
    const url = new URL(options.origin);
    const timeoutMs = options.timeoutMs ?? 5000;
    const attempts = options.pollAttempts ?? 5;
    const interval = options.pollIntervalMs ?? 1000;
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/"
      || !/^[a-z0-9_-]+$/i.test(options.tenant)
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000
      || !Number.isInteger(attempts) || attempts < 1 || attempts > 30
      || !Number.isInteger(interval) || interval < 0 || interval > 10000) fail("invalid-configuration");
    const clientId = "host-verification-" + crypto.randomUUID();
    const marker = "Synthetic identity-runtime verification probe " + crypto.randomUUID();
    const fetcher = options.fetcher ?? fetch;
    async function post(path: string, body: unknown, expected = 200): Promise<unknown> {
      const response = await fetcher(url.origin + path, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
        headers: { "content-type": "application/json", ...(options.token ? { authorization: "Bearer " + options.token } : {}) },
        body: JSON.stringify(body),
      });
      if (response.status !== expected) { await response.body?.cancel(); fail("unexpected-http-status"); }
      if (expected !== 200) { await response.body?.cancel(); return undefined; }
      try { return await response.json(); } catch { return fail("invalid-json"); }
    }
    async function joinSession() {
      const value = await post(`/identity-runtime/${options.tenant}/join`, { clientId, surfaceId: "host-verification", message: "Verify identity-runtime host connectivity." });
      if (!record(value) || ["projection", "leaseId", "sessionToken", "stateHash"].some(k => typeof value[k] !== "string" || !(value[k] as string).trim())
        || typeof value.expiresAt !== "number" || value.expiresAt <= Date.now()
        || !Array.isArray(value.writeScopes) || value.writeScopes.some(s => typeof s !== "string")) return fail("invalid-join");
      return { auth: { clientId, leaseId: value.leaseId, sessionToken: value.sessionToken, stateHash: value.stateHash }, writeScopes: value.writeScopes };
    }
    const direct = "/identity-runtime/continuity/direct-recall";
    function recallItems(value: unknown): Array<{ content: string }> {
      if (!Array.isArray(value) || value.some(v => !record(v) || typeof v.source !== "string" || typeof v.content !== "string")) return fail("invalid-recall");
      return value;
    }
    stage = "join";
    let session = await joinSession();
    checks.push({ name: stage, status: "pass" });
    stage = "direct-recall";
    recallItems(await post(direct, { ...session.auth, query: marker }));
    checks.push({ name: stage, status: "pass" });
    const probes = [
      { name: "auth-missing-token", changes: { sessionToken: undefined }, status: 401 },
      { name: "auth-wrong-token", changes: { sessionToken: "invalid-" + crypto.randomUUID() }, status: 401 },
      { name: "auth-wrong-client", changes: { clientId: "invalid-" + crypto.randomUUID() }, status: 401 },
      { name: "auth-stale-state", changes: { stateHash: "invalid-" + crypto.randomUUID() }, status: 409 },
    ];
    for (const probe of probes) {
      stage = probe.name;
      await post(direct, { ...session.auth, ...probe.changes, query: marker }, probe.status);
      checks.push({ name: stage, status: "pass" });
    }
    if (!options.writeProbe) {
      checks.push({ name: "remember-recall", status: "skip", code: "requires-write-probe" });
      return { ok: true, complete: false, checks };
    }
    stage = "remember";
    if (!session.writeScopes.includes("observation")) fail("observation-not-granted");
    const saved = await post("/identity-runtime/continuity/remember", {
      ...session.auth, idempotencyKey: crypto.randomUUID(),
      entry: { scope: "observation", content: marker, tags: ["host-verification", "synthetic-probe"], source: "identity-runtime-host-verification", confidence: 1 },
    });
    if (!record(saved) || typeof saved.id !== "string" || !saved.id || typeof saved.createdAt !== "string" || !Number.isFinite(Date.parse(saved.createdAt))) fail("invalid-remember");
    checks.push({ name: stage, status: "pass" });
    stage = "rejoin";
    session = await joinSession();
    checks.push({ name: stage, status: "pass" });
    stage = "remember-recall";
    for (let attempt = 0; attempt < attempts; attempt++) {
      const items = recallItems(await post(direct, { ...session.auth, query: marker }));
      // Bruno concatenates multiple memories into one content field.
      if (items.some(item => item.content.includes(marker))) {
        checks.push({ name: stage, status: "pass" });
        return { ok: true, complete: true, checks };
      }
      if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, interval));
    }
    fail("probe-not-recalled");
  } catch (error) {
    checks.push({ name: stage, status: "fail", code: error instanceof ProbeFailure ? error.message : stage === "configuration" ? "invalid-configuration" : "request-failed" });
  }
  return { ok: false, complete: false, checks };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const valid = args.every(arg => arg === "--write-probe");
  const result = await verifyHost({
    origin: valid ? process.env.IDENTITY_RUNTIME_URL ?? "http://127.0.0.1:13541" : "invalid",
    tenant: process.env.IDENTITY_RUNTIME_TENANT ?? "eli",
    token: process.env.IDENTITY_RUNTIME_TOKEN,
    writeProbe: args.includes("--write-probe"),
  });
  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
}

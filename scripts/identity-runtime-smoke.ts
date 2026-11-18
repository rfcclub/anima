const anima = Bun.env.ANIMA_CONTINUITY_URL ?? "http://127.0.0.1:3700";
const runtime = Bun.env.IDENTITY_RUNTIME_URL ?? "http://127.0.0.1:13541";

await requireOk(`${anima}/health`);
await requireOk(`${runtime}/health`);
const results: Array<Record<string, unknown>> = [];
for (const tenant of ["eli", "bruno"] as const) {
  const joined = await requireOk(`${runtime}/identity-runtime/${tenant}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientId: "identity-runtime-smoke",
      surfaceId: `identity-runtime-smoke-${tenant}`,
      message: `Verify the deployed ${tenant} identity runtime boundary.`,
    }),
  });
  if (typeof joined.projection !== "string" || !joined.projection.trim()) throw new Error(`${tenant} join returned no projection`);
  for (const key of ["projectionId", "stateHash", "leaseId", "expiresAt", "sessionToken"]) {
    if (joined[key] === undefined || joined[key] === null) throw new Error(`${tenant} join returned no ${key}`);
  }
  results.push(joined);
}
console.log(JSON.stringify({
  ok: true,
  tenants: results.map((joined, index) => ({
    tenant: index === 0 ? "eli" : "bruno",
    projectionChars: (joined.projection as string).length,
    leaseId: joined.leaseId,
    expiresAt: joined.expiresAt,
  })),
}));

async function requireOk(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`${url} failed: ${body.error ?? response.status}`);
  return body;
}

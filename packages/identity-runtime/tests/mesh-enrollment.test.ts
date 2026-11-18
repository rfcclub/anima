import { afterEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadMeshEnrollmentConfig,
  meshInstallation,
  MeshEnrollmentClient,
  signMeshAdmissionProof,
  type MeshFetch,
} from "../src/mesh-enrollment.ts";

const keys = generateKeyPairSync("ed25519");
let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function decode(token: string): { header: Record<string, unknown>; claims: Record<string, unknown>; valid: boolean } {
  const [header, payload, signature] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(header!, "base64url").toString("utf8")),
    claims: JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")),
    valid: verify(null, Buffer.from(`${header}.${payload}`), keys.publicKey, Buffer.from(signature!, "base64url")),
  };
}

function client(fetchImpl: MeshFetch, timeoutMs = 1_500): MeshEnrollmentClient {
  return new MeshEnrollmentClient({
    meshUrl: "http://mesh.test", issuer: "identity-runtime", kid: "identity-1", privateKey: keys.privateKey,
    timeoutMs, fetch: fetchImpl, now: () => 1_000_000, jti: () => "jti-1",
  });
}

const hint = { harness: "omp", cwd: "/work/eli", machine: "host-1.local" };

describe("signMeshAdmissionProof", () => {
  test("signs a 60 second mesh:enroll proof for one agent", () => {
    const proof = signMeshAdmissionProof({ issuer: "identity-runtime", kid: "identity-1", privateKey: keys.privateKey, agentId: "eli", now: 1_000_000, jti: "jti-1" });
    const decoded = decode(proof);
    expect(decoded.valid).toBe(true);
    expect(decoded.header).toEqual({ alg: "EdDSA", kid: "identity-1" });
    expect(decoded.claims).toEqual({ iss: "identity-runtime", aud: "colony-mesh", sub: "eli", scope: ["mesh:enroll"], iat: 1_000, exp: 1_060, jti: "jti-1" });
  });
});

describe("admission proof deadline", () => {
  test("a proof for a join with a deadline expires no later than that deadline", () => {
    const capped = decode(signMeshAdmissionProof({ issuer: "identity-runtime", kid: "identity-1", privateKey: keys.privateKey, agentId: "eli", now: 1_000_000, jti: "j", notAfter: 1_020_900 }));
    expect(capped.claims.exp).toBe(1_020);
    const uncapped = decode(signMeshAdmissionProof({ issuer: "identity-runtime", kid: "identity-1", privateKey: keys.privateKey, agentId: "eli", now: 1_000_000, jti: "j", notAfter: 9_000_000 }));
    expect(uncapped.claims.exp).toBe(1_060);
  });

  test("enroll signs its proof with the join's deadline, so Mesh refuses it once the deadline passed", async () => {
    let authorization = "";
    const enrolled = await client(async (_url, init) => {
      authorization = String((init?.headers as Record<string, string>).authorization);
      return Response.json({ meshId: "m", leaseExpiresAt: 1, heartbeatCredential: "c" });
    }).enroll("eli", { ...hint, notAfter: 1_030_400 });
    expect(enrolled.status).toBe("enrolled");
    expect(decode(authorization.slice("Bearer ".length)).claims.exp).toBe(1_030);
  });

  test("a proof requested with a deadline is capped the same way", () => {
    expect(decode(client(async () => new Response(null)).proof("eli", 1_005_000)).claims.exp).toBe(1_005);
  });
});

describe("meshInstallation", () => {
  test("builds the same installation body as colony-mesh describeInstallation", () => {
    const hash = createHash("sha256").update("/work/eli").digest("hex").slice(0, 8);
    expect(meshInstallation("eli", hint)).toEqual({
      agent: "eli", installationId: `omp-${hash}`, machine: "host-1", cwd: "/work/eli", harness: "omp",
      route: { kind: "local-a2a", target: `eli-omp-${hash}@host-1` },
    });
  });
});

describe("MeshEnrollmentClient", () => {
  test("returns enrolled with the lease Colony allocated and sends the proof and installation", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const result = await client(async (url, init) => {
      seenUrl = url;
      seenInit = init;
      return Response.json({ meshId: "eli-omp-x@host-1", leaseExpiresAt: 5, heartbeatCredential: "hb" });
    }).enroll("eli", hint);
    expect(result).toEqual({ status: "enrolled", meshId: "eli-omp-x@host-1", leaseExpiresAt: 5, heartbeatCredential: "hb" });
    expect(seenUrl).toBe("http://mesh.test/mesh/v1/join");
    const headers = new Headers(seenInit!.headers);
    expect(decode(headers.get("authorization")!.replace(/^Bearer /, "")).claims.sub).toBe("eli");
    expect(JSON.parse(String(seenInit!.body))).toEqual(meshInstallation("eli", hint));
  });

  test("returns pending when Mesh fails with 5xx, times out, or refuses the connection", async () => {
    expect(await client(async () => new Response(null, { status: 503 })).enroll("eli", hint)).toEqual({ status: "pending", retryable: true });
    const started = Date.now();
    const hanging: MeshFetch = (_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
    expect(await client(hanging, 50).enroll("eli", hint)).toEqual({ status: "pending", retryable: true });
    expect(Date.now() - started).toBeLessThan(1_000);
    const closed = Bun.serve({ port: 0, fetch: () => new Response(null) });
    const port = closed.port;
    closed.stop(true);
    const refused = new MeshEnrollmentClient({ meshUrl: `http://127.0.0.1:${port}`, issuer: "identity-runtime", kid: "identity-1", privateKey: keys.privateKey });
    expect(await refused.enroll("eli", hint)).toEqual({ status: "pending", retryable: true });
  });

  test("returns rejected when Mesh answers 400 or 401", async () => {
    for (const status of [400, 401]) {
      expect(await client(async () => new Response(null, { status })).enroll("eli", hint)).toEqual({ status: "rejected" });
    }
  });
});

describe("loadMeshEnrollmentConfig", () => {
  test("is off when any setting is missing, refuses a key file that is not 0600, and builds a client otherwise", () => {
    root = mkdtempSync(join(tmpdir(), "mesh-enrollment-config-"));
    const keyFile = join(root, "mesh-issuer.pem");
    writeFileSync(keyFile, keys.privateKey.export({ type: "pkcs8", format: "pem" }));
    const env = { IDENTITY_RUNTIME_MESH_URL: "http://127.0.0.1:1526", IDENTITY_RUNTIME_MESH_KEY_FILE: keyFile, IDENTITY_RUNTIME_MESH_KID: "identity-1" };
    expect(loadMeshEnrollmentConfig({})).toBeNull();
    expect(loadMeshEnrollmentConfig({ ...env, IDENTITY_RUNTIME_MESH_KID: undefined })).toBeNull();
    chmodSync(keyFile, 0o644);
    expect(() => loadMeshEnrollmentConfig(env)).toThrow("mesh issuer key file must be mode 0600");
    chmodSync(keyFile, 0o600);
    const loaded = loadMeshEnrollmentConfig(env);
    expect(loaded).toBeInstanceOf(MeshEnrollmentClient);
    expect(decode(loaded!.proof("bruno")).claims.sub).toBe("bruno");
  });
});

describe("MeshEnrollmentClient Mesh calls for a session", () => {
  function meshStandIn(respond: (request: Request) => Response | Promise<Response>) {
    const seen: Array<{ method: string; path: string; authorization: string | null; body: string }> = [];
    const mesh = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch: async (request) => {
        seen.push({ method: request.method, path: new URL(request.url).pathname, authorization: request.headers.get("authorization"), body: await request.text() });
        return respond(request);
      },
    });
    const client = new MeshEnrollmentClient({
      meshUrl: `http://127.0.0.1:${mesh.port}`, issuer: "identity-runtime", kid: "identity-1", privateKey: keys.privateKey,
      timeoutMs: 200, now: () => 1_000_000, jti: () => "jti-1",
    });
    return { client, seen, stop: () => mesh.stop(true) };
  }

  test("IMS-1/IMS-2 sends one message to an exact mesh ID with a 60 s mesh:send grant for the agent", async () => {
    const { client, seen, stop } = meshStandIn(() => Response.json({ results: { "bruno-claude-1@mac": { status: "accepted", conversationId: "c1" } } }));
    try {
      const result = await client.send!("eli", { target: "bruno-claude-1@mac", content: "please review", messageId: "m1", from: "eli-codex-1@mac" });
      expect(result).toEqual({ results: { "bruno-claude-1@mac": { status: "accepted", conversationId: "c1" } } });
      expect(seen.map(({ method, path }) => ({ method, path }))).toEqual([{ method: "POST", path: "/mesh-service/send/bruno-claude-1%40mac/message" }]);
      expect(JSON.parse(seen[0]!.body)).toEqual({ content: "please review", messageId: "m1" });
      const grant = decode(seen[0]!.authorization!.replace(/^Bearer /, ""));
      expect(grant.valid).toBe(true);
      expect(grant.claims).toEqual({ iss: "identity-runtime", aud: "colony-mesh", sub: "eli", scope: ["mesh:send"], iat: 1_000, exp: 1_060, jti: "jti-1", from: "eli-codex-1@mac" });
    } finally { stop(); }
  });

  test("IMS-3 lists the directory with a mesh:list grant", async () => {
    const { client, seen, stop } = meshStandIn(() => Response.json({ "bruno-claude-1@mac": { cwd: "/work/anima", harness: "claude", status: "online" } }));
    try {
      expect(await client.list!("eli")).toEqual({ "bruno-claude-1@mac": { cwd: "/work/anima", harness: "claude", status: "online" } });
      expect(seen.map(({ method, path }) => ({ method, path }))).toEqual([{ method: "GET", path: "/mesh-service/list" }]);
      expect(decode(seen[0]!.authorization!.replace(/^Bearer /, "")).claims).toMatchObject({ sub: "eli", scope: ["mesh:list"] });
    } finally { stop(); }
  });

  test("IMS-6 refuses a prefix target or an empty message without calling Mesh", async () => {
    const { client, seen, stop } = meshStandIn(() => Response.json({}));
    try {
      await expect(client.send!("eli", { target: "bruno", content: "x", messageId: "m1" })).rejects.toThrow("mesh target is invalid");
      await expect(client.send!("eli", { target: "bruno-1@mac", content: "", messageId: "m1" })).rejects.toThrow("mesh message is invalid");
      await expect(client.send!("eli", { target: "bruno-1@mac", content: "x", messageId: "" })).rejects.toThrow("mesh message is invalid");
      expect(seen).toEqual([]);
    } finally { stop(); }
  });

  test("IMS-7 reports a Mesh refusal as denied and an outage or timeout as unavailable", async () => {
    const denied = meshStandIn(() => new Response("unauthorized", { status: 401 }));
    const down = meshStandIn(() => new Response(null, { status: 503 }));
    const hanging = meshStandIn(() => new Promise<Response>(() => {}));
    try {
      await expect(denied.client.send!("eli", { target: "bruno-1@mac", content: "x", messageId: "m1" })).rejects.toThrow("mesh send denied");
      await expect(down.client.send!("eli", { target: "bruno-1@mac", content: "x", messageId: "m1" })).rejects.toThrow("mesh is unavailable");
      await expect(down.client.list!("eli")).rejects.toThrow("mesh is unavailable");
      await expect(hanging.client.send!("eli", { target: "bruno-1@mac", content: "x", messageId: "m1" })).rejects.toThrow("mesh is unavailable");
    } finally { denied.stop(); down.stop(); hanging.stop(); }
    const closed = Bun.serve({ port: 0, fetch: () => new Response(null) });
    const port = closed.port;
    closed.stop(true);
    const refused = new MeshEnrollmentClient({ meshUrl: `http://127.0.0.1:${port}`, issuer: "identity-runtime", kid: "identity-1", privateKey: keys.privateKey });
    await expect(refused.send("eli", { target: "bruno-1@mac", content: "x", messageId: "m1" })).rejects.toThrow("mesh is unavailable");
  });
});

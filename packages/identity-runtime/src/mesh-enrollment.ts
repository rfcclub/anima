import { createHash, createPrivateKey, randomUUID, sign, type KeyObject } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

/**
 * Colony Mesh admission (colony-mesh mesh-remote-join-and-agent-addressing,
 * Task 4). Identity only proves admission; Colony allocates the mesh ID.
 * colony-mesh code is not imported: the HTTP shape is the contract.
 */

export interface MeshInstallationHint {
  harness: string;
  cwd: string;
  machine: string;
  /**
   * Epoch ms after which this join must not enroll. A client that stops waiting at its
   * deadline can then release its installation knowing no late enrollment of this join can still commit.
   */
  notAfter?: number;
}

export type MeshEnrollmentResult =
  | { status: "enrolled"; meshId: string; leaseExpiresAt: number; heartbeatCredential: string }
  | { status: "pending"; retryable: true }
  | { status: "rejected" }
  /** The join's `notAfter` had passed when enrollment would have started; nothing was enrolled. */
  | { status: "expired" };

export type MeshFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface MeshSendInput {
  /** One exact mesh ID; prefix fan-out is not offered to sessions. */
  target: string;
  content: string;
  messageId: string;
  /** The caller's own mesh ID; Mesh accepts it only for the agent's own registration. */
  from?: string;
}

export interface MeshEnrollmentPort {
  enroll(agentId: string, hint: MeshInstallationHint): Promise<MeshEnrollmentResult>;
  /** `notAfter` (epoch ms) caps the proof's expiry, so Mesh refuses it once that deadline passed. */
  proof(agentId: string, notAfter?: number): string;
  /** Mesh directory and send on behalf of a session's agent; the grant stays inside identity-runtime. */
  list?(agentId: string): Promise<unknown>;
  send?(agentId: string, input: MeshSendInput): Promise<unknown>;
}

const PROOF_TTL_SECONDS = 60;

export function signMeshAdmissionProof(input: {
  issuer: string; kid: string; privateKey: KeyObject; agentId: string; now: number; jti: string; notAfter?: number;
}): string {
  return signMeshGrant({ ...input, scope: ["mesh:enroll"] });
}

/** A 60 s Colony Mesh grant for one agent and one scope set; `from` is added only when given. */
export function signMeshGrant(input: {
  issuer: string; kid: string; privateKey: KeyObject; agentId: string; now: number; jti: string; scope: string[]; from?: string;
  /** Epoch ms; the grant expires no later than this (a join's admission deadline). */
  notAfter?: number;
}): string {
  const iat = Math.floor(input.now / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: input.kid })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: input.issuer, aud: "colony-mesh", sub: input.agentId, scope: input.scope,
    iat, exp: input.notAfter === undefined ? iat + PROOF_TTL_SECONDS : Math.min(iat + PROOF_TTL_SECONDS, Math.floor(input.notAfter / 1000)), jti: input.jti,
    ...(input.from !== undefined ? { from: input.from } : {}),
  })).toString("base64url");
  const signature = sign(null, Buffer.from(`${header}.${payload}`), input.privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

/** Must match colony-mesh `describeInstallation` and `meshMachineName`. */
export function meshInstallation(agentId: string, hint: MeshInstallationHint) {
  assertMeshInstallationHint(hint);
  const machine = meshMachineName(hint.machine);
  const installationId = `${hint.harness}-${createHash("sha256").update(hint.cwd).digest("hex").slice(0, 8)}`;
  return {
    agent: agentId,
    installationId,
    machine,
    cwd: hint.cwd,
    harness: hint.harness,
    // Mesh accepts only the installation's own mesh ID (agentName-harness-slug@machine) as the route, never agent@harness.
    route: { kind: "local-a2a", target: `${agentId}-${installationId}@${machine}` },
  };
}

export function assertMeshInstallationHint(hint: MeshInstallationHint): void {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(hint.harness) || !hint.cwd || !meshMachineName(hint.machine)
    || (hint.notAfter !== undefined && !Number.isFinite(hint.notAfter))) {
    throw new Error("mesh installation is invalid");
  }
}

function meshMachineName(hostname: string): string {
  return (hostname.split(".")[0] ?? "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

export interface MeshEnrollmentClientOptions {
  meshUrl: string;
  issuer: string;
  kid: string;
  privateKey: KeyObject;
  timeoutMs?: number;
  fetch?: MeshFetch;
  now?: () => number;
  jti?: () => string;
}

/** One bounded call; never throws, so a Mesh outage cannot fail an identity join. */
export class MeshEnrollmentClient implements MeshEnrollmentPort {
  constructor(private readonly options: MeshEnrollmentClientOptions) {}

  proof(agentId: string, notAfter?: number): string {
    return this.grant(agentId, ["mesh:enroll"], undefined, notAfter);
  }

  async list(agentId: string): Promise<unknown> {
    return this.call("GET", "/mesh-service/list", this.grant(agentId, ["mesh:list"]));
  }

  async send(agentId: string, input: MeshSendInput): Promise<unknown> {
    if (!input.target.includes("@")) throw new Error("mesh target is invalid");
    if (!input.content || !input.messageId) throw new Error("mesh message is invalid");
    const path = `/mesh-service/send/${encodeURIComponent(input.target)}/message`;
    return this.call("POST", path, this.grant(agentId, ["mesh:send"], input.from), { content: input.content, messageId: input.messageId });
  }

  private grant(agentId: string, scope: string[], from?: string, notAfter?: number): string {
    return signMeshGrant({
      issuer: this.options.issuer, kid: this.options.kid, privateKey: this.options.privateKey, agentId,
      now: (this.options.now ?? Date.now)(), jti: (this.options.jti ?? randomUUID)(), scope, from, notAfter,
    });
  }

  /** One bounded Mesh call; a Mesh refusal is "denied", anything else that fails is "unavailable". */
  private async call(method: "GET" | "POST", path: string, grant: string, body?: unknown): Promise<unknown> {
    const fetchImpl: MeshFetch = this.options.fetch ?? ((url, init) => fetch(url, init));
    let response: Response;
    try {
      response = await fetchImpl(`${this.options.meshUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${grant}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 1_500),
      });
    } catch {
      throw new Error("mesh is unavailable");
    }
    if (response.status === 401) throw new Error("mesh send denied");
    if (!response.ok) throw new Error("mesh is unavailable");
    try { return await response.json(); }
    catch { throw new Error("mesh is unavailable"); }
  }

  async enroll(agentId: string, hint: MeshInstallationHint): Promise<MeshEnrollmentResult> {
    const fetchImpl: MeshFetch = this.options.fetch ?? ((url, init) => fetch(url, init));
    try {
      const response = await fetchImpl(`${this.options.meshUrl}/mesh/v1/join`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.proof(agentId, hint.notAfter)}`, "content-type": "application/json" },
        body: JSON.stringify(meshInstallation(agentId, hint)),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 1_500),
      });
      if (response.status === 400 || response.status === 401) return { status: "rejected" };
      if (!response.ok) return { status: "pending", retryable: true };
      const lease = await response.json() as Record<string, unknown>;
      if (typeof lease.meshId !== "string" || typeof lease.heartbeatCredential !== "string" || typeof lease.leaseExpiresAt !== "number") {
        return { status: "pending", retryable: true };
      }
      return { status: "enrolled", meshId: lease.meshId, leaseExpiresAt: lease.leaseExpiresAt, heartbeatCredential: lease.heartbeatCredential };
    } catch {
      return { status: "pending", retryable: true };
    }
  }
}

/** Off unless all three settings exist; the private key file must be owner-only. */
export function loadMeshEnrollmentConfig(env: Record<string, string | undefined>): MeshEnrollmentClient | null {
  const meshUrl = env.IDENTITY_RUNTIME_MESH_URL;
  const keyFile = env.IDENTITY_RUNTIME_MESH_KEY_FILE;
  const kid = env.IDENTITY_RUNTIME_MESH_KID;
  if (!meshUrl || !keyFile || !kid) return null;
  if ((statSync(keyFile).mode & 0o777) !== 0o600) throw new Error("mesh issuer key file must be mode 0600");
  const privateKey = createPrivateKey(readFileSync(keyFile, "utf8"));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("mesh issuer key must be Ed25519");
  return new MeshEnrollmentClient({ meshUrl, issuer: "identity-runtime", kid, privateKey });
}

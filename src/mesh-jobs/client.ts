/** Wire types of the colony-mesh `/jobs` routes (rfcclub/colony-mesh, src/a2a/job-store.ts). */
export type JobType = "review" | "review-intent" | "revise" | "start-work" | "merge-signal";
export interface JobTarget { repo: string; kind: "issue" | "pr"; number: number; headSha?: string }
export interface MeshJob {
  id: string;
  enqueuer: string;
  type: JobType;
  target: JobTarget;
  slots: number;
  expiresAt: number;
  state: "queued" | "reported" | "completed" | "expired";
  createdAt: number;
  /** Opaque reference to the ANIMA work this job belongs to (start-work and revise jobs). */
  workRef?: string;
}
export interface MeshClaim {
  id: string;
  jobId: string;
  worker: string;
  state: "active" | "reported" | "failed" | "lost" | "released";
  leaseExpiresAt: number;
  evidenceRef: string | null;
}
/** A job read by its enqueuer or claimant, including the claims used to decide whether a retry is safe. */
export interface MeshJobDetails extends MeshJob {
  eligible: string[] | null;
  excluded: string[];
  claims: MeshClaim[];
}
export type MeshJobReport = { outcome: "done"; evidenceRef: string } | { outcome: "failed" };

/** Any non-2xx except 409. The message carries the status and the gateway's text, never the bearer. */
export class MeshJobsHttpError extends Error {
  constructor(readonly status: number, detail: string) {
    super(`mesh jobs gateway returned ${status}${detail ? `: ${detail}` : ""}`);
  }
}

/** 409: the lease is lost or the job expired. The claim no longer belongs to this worker. */
export class LeaseLostError extends MeshJobsHttpError {}

/** The agent is not online in Mesh, so it has no credential yet. Retry on a later tick. */
export class MeshJobsOfflineError extends Error {
  constructor() { super("mesh jobs worker is not online in Mesh"); }
}

export class MeshJobsClient {
  constructor(
    private readonly gatewayUrl: string,
    /** The agent's current mesh credential, read on every call; it changes after a rejoin (rfcclub/anima#103). */
    private readonly capability: () => string | null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async pending(): Promise<number> {
    return ((await this.call("GET", "/jobs/pending")) as { count: number }).count;
  }

  async claim(): Promise<MeshClaim | null> {
    return (await this.call("POST", "/jobs/claim")) as MeshClaim | null;
  }

  async getJob(jobId: string): Promise<MeshJobDetails> {
    return (await this.call("GET", `/jobs/${encodeURIComponent(jobId)}`)) as MeshJobDetails;
  }

  async heartbeat(claimId: string): Promise<MeshClaim> {
    return (await this.call("POST", `/jobs/claims/${encodeURIComponent(claimId)}/heartbeat`)) as MeshClaim;
  }

  async report(claimId: string, report: MeshJobReport): Promise<MeshClaim> {
    return (await this.call("POST", `/jobs/claims/${encodeURIComponent(claimId)}/report`, report)) as MeshClaim;
  }

  /** Puts a job on the queue as the caller (the enqueuer). Used by the work reconciler for review and revise jobs. */
  async enqueue(input: Record<string, unknown>): Promise<MeshJob> {
    return (await this.call("POST", "/jobs", input)) as MeshJob;
  }

  /** The enqueuer's confirmation of a reported job. Only called after the work was accepted. */
  async confirm(jobId: string): Promise<MeshJob> {
    return (await this.call("POST", `/jobs/${encodeURIComponent(jobId)}/confirm`)) as MeshJob;
  }

  /** Hands an unfinished start-work or revise claim back; the job stays queued for the same eligible workers. */
  async release(claimId: string): Promise<MeshClaim> {
    return (await this.call("POST", `/jobs/claims/${encodeURIComponent(claimId)}/release`)) as MeshClaim;
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const capability = this.capability();
    if (!capability) throw new MeshJobsOfflineError();
    const headers: Record<string, string> = { authorization: `Bearer ${capability}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await this.fetchImpl(`${this.gatewayUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 204) return null;
    if (response.ok) return response.json();
    const detail = (await response.text().catch(() => "")).slice(0, 200).split(capability).join("[redacted]");
    if (response.status === 409) throw new LeaseLostError(409, detail);
    throw new MeshJobsHttpError(response.status, detail);
  }
}

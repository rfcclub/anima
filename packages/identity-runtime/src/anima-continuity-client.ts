import {
  RememberRejectedError,
  RoomCommitRejectedError,
  type ActiveJoinIntent,
  type RemoteCompileResult,
  type RemoteContinuityPort,
  type RemoteDirectRecallRequest,
  type RemoteDirectRecallResult,
  type RemoteRecallRequest,
  type RemoteRecallResult,
  type RemoteRememberRequest,
  type RemoteRememberResult,
  type RemoteRoomReadRequest,
  type SharedRoomReadResult,
  type RemoteRoomCommitRequest,
  type SharedRoomCommitResult,
} from "../../../src/identity-runtime/contract/remote-continuity.ts";

/** Structural fetch subset used by the private ANIMA continuity transport. */
export type AnimaContinuityFetcher = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * HTTP adapter for one registered ANIMA identity.
 * The tenant is constructor-owned, so callers cannot select an identity in
 * arbitrary request bodies after the runtime has been configured.
 */
export class HttpAnimaTenantContinuityClient implements RemoteContinuityPort {
  constructor(
    private readonly origin: string,
    private readonly agentId: string,
    private readonly fetcher: AnimaContinuityFetcher = fetch,
  ) {}

  compile(input: ActiveJoinIntent): Promise<RemoteCompileResult> {
    if (input.identity !== this.agentId) {
      return Promise.reject(new Error("identity must match configured tenant"));
    }
    return this.request("/compile", input);
  }

  remember(input: RemoteRememberRequest): Promise<RemoteRememberResult> {
    return this.request("/remember", input);
  }

  recall(input: RemoteRecallRequest): Promise<RemoteRecallResult> {
    return this.request("/recall", input);
  }

  directRecall(input: RemoteDirectRecallRequest): Promise<RemoteDirectRecallResult> {
    return this.request("/direct-recall", input);
  }

  readRoom(input: RemoteRoomReadRequest): Promise<SharedRoomReadResult> {
    return this.request("/read-room", input);
  }

  commitRoom(input: RemoteRoomCommitRequest, signal?: AbortSignal): Promise<SharedRoomCommitResult> {
    return this.request("/commit-room", input, signal);
  }

  private async request<T>(operation: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const response = await this.fetcher(
      this.origin.replace(/\/$/, "") + "/internal/continuity/" + this.agentId + operation,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      },
    );
    const payload = await response.json() as T & { error?: string; rejectedBeforeWrite?: boolean; rejectedBeforeCommit?: boolean };
    if (!response.ok) {
      const message = payload.error ?? "ANIMA continuity request failed (" + response.status + ")";
      if (operation === "/commit-room" && payload.rejectedBeforeCommit === true) throw new RoomCommitRejectedError(message);
      throw payload.rejectedBeforeWrite ? new RememberRejectedError(message) : new Error(message);
    }
    return payload;
  }
}

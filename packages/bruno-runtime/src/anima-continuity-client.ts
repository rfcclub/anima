import {
  HttpAnimaTenantContinuityClient,
  type ActiveJoinIntent,
  type AnimaContinuityFetcher,
  type RemoteCompileResult,
  type RemoteContinuityPort,
  type RemoteRecallRequest,
  type RemoteRecallResult,
  type RemoteRememberRequest,
  type RemoteRememberResult,
} from "../../identity-runtime/src/index.ts";

export type Fetcher = AnimaContinuityFetcher;

/** Compatibility facade for Bruno's fixed tenant continuity client. */
export class HttpBrunoContinuityClient implements RemoteContinuityPort {
  private readonly client: HttpAnimaTenantContinuityClient;

  constructor(origin: string, fetcher: Fetcher = fetch) {
    this.client = new HttpAnimaTenantContinuityClient(origin, "bruno", fetcher);
  }

  compile(input: ActiveJoinIntent): Promise<RemoteCompileResult> {
    return this.client.compile(input);
  }

  remember(input: RemoteRememberRequest): Promise<RemoteRememberResult> {
    return this.client.remember(input);
  }

  recall(input: RemoteRecallRequest): Promise<RemoteRecallResult> {
    return this.client.recall(input);
  }
}

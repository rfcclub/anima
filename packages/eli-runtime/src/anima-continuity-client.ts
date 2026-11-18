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

/** Compatibility facade for Eli's fixed tenant continuity client. */
export class HttpAnimaContinuityClient implements RemoteContinuityPort {
  private readonly client: HttpAnimaTenantContinuityClient;

  constructor(origin: string, fetcher: AnimaContinuityFetcher = fetch) {
    this.client = new HttpAnimaTenantContinuityClient(origin, "eli", fetcher);
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

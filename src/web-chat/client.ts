import { signedHeaders, type Operation } from "./ipc";
import type { ChatOwner } from "./types";
import { createHash } from "node:crypto";
export class WebChatClient {
  private readonly privateRegistrations = new Map<string, Promise<void>>();
  constructor(
    private readonly socket: string,
    private readonly key: Uint8Array,
  ) {}
  /** Trusted boot registration, scoped to this client's bridge lifetime. Failed chunks retry. */
  async registerPrivateContent(
    owner: ChatOwner,
    contents: string[],
    signal?: AbortSignal,
  ) {
    for (const content of contents) {
      for (let offset = 0; offset < content.length; offset += 8000) {
        signal?.throwIfAborted();
        const chunk = content.slice(offset, offset + 8064);
        const digest = createHash("sha256").update(chunk).digest("hex");
        let registration = this.privateRegistrations.get(digest);
        if (!registration) {
          if (this.privateRegistrations.size >= 40_000)
            throw Error(
              `private source registry full (${this.privateRegistrations.size}/40000 chunks); restart the web-chat bridge or reduce registered boot content`,
            );
          registration = this.call(
            owner,
            { operation: "register_private", content: chunk },
            signal,
          )
            .then(() => {})
            .catch((error) => {
              this.privateRegistrations.delete(digest);
              throw error;
            });
          this.privateRegistrations.set(digest, registration);
        }
        await registration;
        signal?.throwIfAborted();
      }
    }
  }
  async call(
    owner: ChatOwner,
    operation: Operation,
    signal?: AbortSignal,
  ): Promise<any> {
    const body = JSON.stringify({ ...operation, owner });
    if (Buffer.byteLength(body) > 65_536) throw Error("request too large");
    const response = await fetch("http://localhost/rpc", {
      method: "POST",
      body,
      headers: signedHeaders(this.key, body),
      unix: this.socket,
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(22_000)])
        : AbortSignal.timeout(22_000),
    } as RequestInit);
    const result = (await response.json()) as any;
    if (!response.ok) throw Error(result.error ?? "bridge unavailable");
    return result;
  }
}

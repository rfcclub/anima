import type { ProviderChunk } from "../../providers/interface";

/**
 * Build a ReadableStream that yields SSE-formatted chunks from an
 * AsyncGenerator<ProviderChunk>.
 *
 * `agentTag`, when given, wraps every text chunk as a `{agent, type,
 * content}` frame instead of a plain JSON string — this is how the VN
 * room surface (castle) tells the client which agent actually spoke, so
 * the bubble nameplate and chat log reflect the resolved speaker instead
 * of always falling back to the room owner (see readBeats in castle lib/beat-stream.ts, used by
 * RoomScreen.tsx).
 */
export function sseFromGenerator(gen: AsyncGenerator<ProviderChunk>, agentTag?: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  // After the client has left nothing more is written: an enqueue on a cancelled stream throws.
  let left = false;
  return new ReadableStream<Uint8Array>({
    cancel() { left = true; },
    async start(rawController) {
      const controller = {
        enqueue: (chunk: Uint8Array) => { if (!left) { try { rawController.enqueue(chunk); } catch { left = true; } } },
        close: () => { try { rawController.close(); } catch { /* already closed */ } },
      };
      try {
        for await (const chunk of gen) {
          if (left) break;
          if (chunk.type === "text" && chunk.content !== undefined) {
            const payload = agentTag
              ? JSON.stringify({ agent: agentTag, type: "text", content: chunk.content })
              : JSON.stringify(chunk.content);
            controller.enqueue(enc.encode(`data: ${payload}\n\n`));
          } else if (chunk.type === "tool_call" && chunk.tool_call) {
            const { name, arguments: args } = chunk.tool_call;
            // Emit a short summary — truncate args to avoid noise
            let summary = name;
            try {
              const parsed = JSON.parse(args);
              const firstVal = Object.values(parsed)[0];
              if (typeof firstVal === "string") summary = `${name}(${firstVal.slice(0, 60)})`;
            } catch { /* keep name only */ }
            controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: "tool_use", name, summary })}\n\n`));
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ error: msg })}\n\n`));
      } finally {
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });
}

let hideThink = true; // strip think tags from model responses by default

export function getHideThink(): boolean {
  return hideThink;
}

export function setHideThink(value: boolean): void {
  hideThink = value;
}

export function stripThinkTags(text: string): string {
  return text.replace(/<think[^>]*>[\s\S]*?<\/think[^>]*>\s*/gi, "").trim();
}

/** Return a one-shot SSE response containing a single text message then [DONE]. */
export function sseText(text: string): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(`data: ${JSON.stringify(text)}\n\ndata: [DONE]\n\n`));
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

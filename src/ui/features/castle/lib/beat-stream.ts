/** One speaker's whole answer within a talk response. */
export interface Beat {
  speaker: string;
  content: string;
}

/** Where a send stands before its first answer: waiting behind another send (`queued`), or its own run has begun. */
export type SendStatus = "queued" | "running";

/** Reads a talk SSE response as it arrives and hands each speaker's answer to
 *  `onBeat` as soon as that speaker's beat ends: on its `beat_end` frame, when
 *  another speaker or the narrator starts, or at `[DONE]` / end of body. Frames
 *  are `{agent, type, content}`; untagged frames are the single-agent plain-text
 *  fallback, delivered as `fallbackSpeaker` only if nothing was tagged.
 *  A `{type: "queued"}` frame (the room was busy) calls `onStatus("queued")`; the first frame of any other kind after
 *  it calls `onStatus("running")`. A response that was never queued reports nothing.
 *  Returns the number of beats delivered. */
export async function readBeats(
  res: Response,
  fallbackSpeaker: string,
  onBeat: (beat: Beat) => void,
  onStatus?: (status: SendStatus) => void,
): Promise<number> {
  const reader = res.body?.getReader();
  if (!reader) return 0;
  const decoder = new TextDecoder();
  let buffer = "";
  let current: Beat | null = null;
  let delivered = 0;
  let plain = "";
  let queued = false;
  const running = () => {
    if (queued) { queued = false; onStatus?.("running"); }
  };

  const endBeat = () => {
    if (current) onBeat(current);
    if (current) delivered++;
    current = null;
  };

  // Returns false once `[DONE]` is seen.
  const handleLine = (line: string): boolean => {
    if (!line.startsWith("data: ")) return true;
    const v = line.slice(6);
    if (v === "[DONE]") return false;
    if (v.startsWith("{")) {
      try {
        const frame = JSON.parse(v) as { agent?: string; type?: string; content?: string };
        if (frame.type === "queued") {
          queued = true;
          onStatus?.("queued");
          return true;
        }
        running();
        if (frame.agent === "narrator" && frame.type === "text" && frame.content) {
          endBeat();
          onBeat({ speaker: "narrator", content: frame.content });
          delivered++;
        } else if (frame.agent && frame.type === "text" && frame.content) {
          if (current?.speaker !== frame.agent) {
            endBeat();
            current = { speaker: frame.agent, content: "" };
          }
          current.content += frame.content;
        } else if (frame.type === "beat_end" && current?.speaker === frame.agent) {
          endBeat();
        }
        return true;
      } catch {
        // not JSON — fall through to plain-text handling
      }
    }
    running();
    plain += v.startsWith('"') ? JSON.parse(v) : v;
    return true;
  };

  let open = true;
  while (open) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!handleLine(line)) { open = false; break; }
    }
  }
  if (open && buffer) handleLine(buffer);
  if (!open) void reader.cancel().catch(() => {});
  endBeat();
  if (delivered === 0 && plain) {
    onBeat({ speaker: fallbackSpeaker, content: plain });
    delivered++;
  }
  return delivered;
}

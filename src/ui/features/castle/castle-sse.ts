import type { GardenEvent } from "../../../garden/events";
import type { VNPayload } from "./castle-director";

/** Encode one castle event + compiled payload as an SSE frame. */
export function sseFrame(event: GardenEvent, payload: VNPayload): string {
  return `data: ${JSON.stringify({ id: event.id, ts: event.timestamp, payload })}\n\n`;
}

export const DONE_FRAME = "data: [DONE]\n\n";

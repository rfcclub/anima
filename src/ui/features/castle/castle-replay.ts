/**
 * Castle Replay — finite, paced SSE stream over a historical event range.
 *
 * GET /api/castle/replay?from=<epoch-ms>&to=<epoch-ms>&speed=<n>
 *
 * Compiles events through the SAME director as the live feed
 * (eventToVnPayload) so replay can never render differently from live.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { JsonlGardenEventStore } from "../../../garden/event-store";
import { eventToVnPayloads } from "./castle-director";
import { sseFrame, DONE_FRAME } from "./castle-sse";
import type { GardenEvent } from "../../../garden/events";

export interface CastleReplayOptions {
  from: number;
  to: number;
  /** 0 = as fast as possible; n = real gaps divided by n. */
  speed?: number;
  roomsDir?: string;
}

/** Upper bound on any single inter-frame delay. */
export const FRAME_DELAY_CAP_MS = 2000;

const DEFAULT_ROOMS_DIR = () =>
  process.env.ANIMA_ROOMS_DIR ?? join(homedir(), ".anima", "rooms");

function eventsPath(roomsDir: string): string {
  return join(roomsDir, "_shared", "garden", "events.jsonl");
}

function eventMs(e: GardenEvent): number {
  return Date.parse(e.timestamp);
}

export function createCastleReplayStream(
  opts: CastleReplayOptions,
): ReadableStream<Uint8Array> {
  const roomsDir = opts.roomsDir ?? DEFAULT_ROOMS_DIR();
  const store = new JsonlGardenEventStore(eventsPath(roomsDir));
  const speed = opts.speed ?? 0;
  const encoder = new TextEncoder();
  let stopped = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const all = await store.readAll({});
        const range = all
          .filter((e) => {
            const ts = eventMs(e);
            return ts >= opts.from && ts <= opts.to;
          })
          .sort((a, b) => eventMs(a) - eventMs(b));

        let prevTs: number | null = null;
        for (const event of range) {
          if (stopped) break;
          const payloads = eventToVnPayloads(event);
          if (payloads.length === 0) continue;
          if (speed > 0 && prevTs !== null) {
            const gap = Math.max(0, eventMs(event) - prevTs);
            await sleep(Math.min(gap / speed, FRAME_DELAY_CAP_MS));
            if (stopped) break;
          }
          for (const payload of payloads) {
            controller.enqueue(encoder.encode(sseFrame(event, payload)));
          }
          prevTs = eventMs(event);
        }
        controller.enqueue(encoder.encode(DONE_FRAME));
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() {
      stopped = true;
    },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

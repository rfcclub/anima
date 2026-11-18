/**
 * Castle Feed — SSE endpoint reading AGENT_MOVED events from the garden store.
 *
 * GET /api/castle/feed?since=<eventId>
 *
 * Emits VN-payload frames derived from AGENT_MOVED events. `since` lets a
 * client reconnect without replaying the full history; omitted `since` starts
 * from the latest event (live tail only).
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { JsonlGardenEventStore } from "../../../garden/event-store";
import { eventToVnPayloads, type VNPayload } from "./castle-director";
import { sseFrame } from "./castle-sse";
import type { GardenEvent } from "../../../garden/events";

export interface CastleFeedOptions {
  roomsDir?: string;
  /** Poll interval in ms when watching for new events. */
  pollMs?: number;
  /** Max events to backfill when `since` is provided. */
  backfillLimit?: number;
  /**
   * Only stream events with id strictly greater than `since`. Omitting it
   * backfills the most recent history (up to `backfillLimit`) before the
   * live tail.
   */
  since?: string;
}

const DEFAULT_ROOMS_DIR = () => process.env.ANIMA_ROOMS_DIR ?? join(homedir(), ".anima", "rooms");

function eventsPath(roomsDir: string): string {
  return join(roomsDir, "_shared", "garden", "events.jsonl");
}

/** Emit one SSE frame per compiled payload for `event`, preserving order. */
function enqueueEvent(controller: ReadableStreamDefaultController<Uint8Array>, encoder: TextEncoder, event: GardenEvent, payloads: VNPayload[]): void {
  for (const payload of payloads) {
    controller.enqueue(encoder.encode(sseFrame(event, payload)));
  }
}

/** Build a ReadableStream that emits SSE frames for the castle feed. */
export function createCastleFeedStream(opts: CastleFeedOptions = {}): ReadableStream<Uint8Array> {
  const roomsDir = opts.roomsDir ?? DEFAULT_ROOMS_DIR();
  const store = new JsonlGardenEventStore(eventsPath(roomsDir));
  const pollMs = opts.pollMs ?? 2000;
  const backfillLimit = opts.backfillLimit ?? 500;
  const since = opts.since;

  const encoder = new TextEncoder();
  let stopped = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const all = await store.readAll({});
        // Determine the starting index: with `since`, skip every event whose
        // id is <= since (SC-006). Without `since`, backfill the most recent
        // `backfillLimit` events (SC-007).
        let backfill: GardenEvent[];
        let lastId: string;
        if (since) {
          const sinceIdx = all.findIndex((e) => e.id === since);
          const start = sinceIdx === -1 ? 0 : sinceIdx + 1;
          backfill = all.slice(start);
          lastId = all.length > 0 ? all[all.length - 1].id : "";
        } else {
          backfill = all.slice(-backfillLimit);
          lastId = all.length > 0 ? all[all.length - 1].id : "";
        }
        for (const event of backfill) {
          const payloads = eventToVnPayloads(event);
          if (payloads.length > 0) enqueueEvent(controller, encoder, event, payloads);
        }
        // Live tail: poll for new events
        while (!stopped) {
          await sleep(pollMs);
          if (stopped) break;
          const fresh = await store.readAll({});
          // When the feed started on an empty spine (lastId still unset), emit
          // every fresh event — otherwise a client that connected before any
          // event existed would never receive the first one.
          const afterLast = lastId
            ? fresh.slice(findIndexAfter(fresh, lastId))
            : fresh;
          for (const event of afterLast) {
            const payloads = eventToVnPayloads(event);
            if (payloads.length > 0) enqueueEvent(controller, encoder, event, payloads);
          }
          if (fresh.length > 0) lastId = fresh[fresh.length - 1].id;
        }
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() {
      stopped = true;
    },
  });
}

/** Find the index of the first event strictly after the given id. */
function findIndexAfter(events: GardenEvent[], id: string): number {
  const idx = events.findIndex((e) => e.id === id);
  return idx === -1 ? events.length : idx + 1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

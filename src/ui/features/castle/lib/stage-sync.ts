import type { RoomCharacter } from "../engine/room-stage";

/** What the sync needs from the stage: draw the characters (resolving to the ids whose portrait could not be
 *  loaded and got a placeholder) and remove characters by id. Injected so the sync runs without Pixi. */
export interface StageDriver {
  draw(agents: RoomCharacter[]): Promise<string[]>;
  clear(ids: string[]): void;
}

export interface StageSync {
  /** The canvas and background are ready: draw whatever is wanted. */
  setReady(): void;
  /** The characters that should be on stage now (the latest call wins). */
  set(agents: RoomCharacter[]): void;
  /** Stop: no more draws and no pending retry. */
  dispose(): void;
}

export interface StageSyncOptions {
  /** Delay before each retry of a draw that left placeholders or threw; no more retries after the last one. */
  retryDelaysMs?: number[];
  /** Schedules `fn` after `ms` and returns a canceller. Defaults to `setTimeout`. */
  setTimer?: (fn: () => void, ms: number) => () => void;
}

const DEFAULT_RETRY_DELAYS_MS = [1500, 4000, 10000];

const keyOf = (agents: RoomCharacter[]) => agents.map((a) => `${a.agentId}:${a.highlighted ? 1 : 0}`).join("|");

/** Keeps the Pixi stage equal to the latest wanted characters. One draw runs at a time; a newer wish made during
 *  a draw is drawn right after it; every draw first removes what the last one added, so nothing goes stale or
 *  doubles; wishes made before the canvas is ready are drawn once it is; a draw that left placeholders or threw
 *  is tried again after a delay. */
export function createStageSync(driver: StageDriver, options: StageSyncOptions = {}): StageSync {
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  });

  let wanted: RoomCharacter[] = [];
  let ready = false;
  let disposed = false;
  let running = false;
  let drawnIds: string[] = [];
  let drawnKey: string | null = ""; // the stage starts empty, which is what "no characters" means
  let attempts = 0;
  let cancelRetry: (() => void) | null = null;

  async function run(): Promise<void> {
    if (!ready || disposed || running) return;
    running = true;
    try {
      while (!disposed && keyOf(wanted) !== drawnKey) {
        const agents = wanted;
        const key = keyOf(agents);
        try {
          driver.clear(drawnIds);
        } catch {
          // a sprite that is not on the canvas is already gone
        }
        drawnIds = agents.map((a) => a.agentId);
        let failed: string[];
        try {
          failed = await driver.draw(agents);
        } catch {
          failed = drawnIds;
        }
        drawnKey = failed.length > 0 ? null : key;
        if (failed.length > 0 && key === keyOf(wanted)) {
          scheduleRetry();
          break;
        }
        if (failed.length === 0 && key === keyOf(wanted)) attempts = 0;
      }
    } finally {
      running = false;
    }
  }

  function scheduleRetry(): void {
    if (attempts >= delays.length || cancelRetry) return;
    const delay = delays[attempts++]!;
    cancelRetry = setTimer(() => {
      cancelRetry = null;
      void run();
    }, delay);
  }

  return {
    setReady() {
      ready = true;
      void run();
    },
    set(agents) {
      const same = keyOf(agents) === keyOf(wanted);
      wanted = agents;
      // The same wish again (a presence poll that found nobody moved) changes nothing: it must not draw ahead of a
      // pending retry or past the retry limit.
      if (same) return;
      // A different wish is a new job: it gets the whole retry budget, whatever an earlier one used up, and the
      // old wish's pending retry must not set its delay.
      attempts = 0;
      cancelRetry?.();
      cancelRetry = null;
      void run();
    },
    dispose() {
      disposed = true;
      cancelRetry?.();
      cancelRetry = null;
    },
  };
}

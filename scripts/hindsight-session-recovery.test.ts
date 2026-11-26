import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consumeBanner,
  emptyState,
  loadState,
  parseRetainFailures,
  recoverOnce,
  retainSession,
  saveState,
  takeBanner,
  type RecoveryState,
} from "./hindsight-session-recovery";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hindsight-recovery-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const diagnostic = (sessionId: string, at: number) =>
  `${JSON.stringify({ event: "retain_failed", session_id: sessionId, timestamp: new Date(at).toISOString(), error: "ECONNREFUSED" })}\n`;

/** Records what a run did so the tests can assert on side effects, not only on state. */
function harness(transcripts: Record<string, string>) {
  const retained: Array<{ sessionId: string; transcript: string }> = [];
  const lines: string[] = [];
  return {
    retained,
    lines,
    deps: {
      readTranscript: (sessionId: string) => transcripts[sessionId],
      retain: async (sessionId: string, transcript: string) => {
        retained.push({ sessionId, transcript });
      },
      report: (line: string) => lines.push(line),
    },
  };
}

test("HR-1: a session that failed while the server was down is retained once, and a second run changes nothing", async () => {
  const h = harness({ "session-a": "user: hi\nassistant: hello\n" });
  const failures = parseRetainFailures(diagnostic("session-a", 1_000));

  const first = await recoverOnce(emptyState(), failures, h.deps, { apply: true, now: 2_000 });
  expect(h.retained).toEqual([{ sessionId: "session-a", transcript: "user: hi\nassistant: hello\n" }]);
  expect(h.lines).toEqual(["hindsight recovery: retained session session-a"]);

  // Same diagnostics re-read after recovery: nothing is replayed.
  const second = await recoverOnce(first, parseRetainFailures(diagnostic("session-a", 1_000)), h.deps, { apply: true, now: 3_000 });
  expect(h.retained.length).toBe(1);
  expect(h.lines.length).toBe(1);
  expect(second.outcomes["session-a"]).toBe("retained");
});

test("HR-2: a failed session whose transcript is gone is reported unrecoverable and never retried", async () => {
  const h = harness({});
  const failures = parseRetainFailures(diagnostic("session-gone", 1_000));

  const first = await recoverOnce(emptyState(), failures, h.deps, { apply: true, now: 2_000 });
  expect(h.retained).toEqual([]);
  expect(h.lines).toEqual(["hindsight recovery: session session-gone cannot be recovered (transcript gone)"]);
  expect(first.outcomes["session-gone"]).toBe("unrecoverable");

  await recoverOnce(first, parseRetainFailures(diagnostic("session-gone", 1_000)), h.deps, { apply: true, now: 3_000 });
  expect(h.lines.length).toBe(1);
});

test("HR-3: no failures means no output", async () => {
  const h = harness({ "session-a": "turns\n" });
  const state = await recoverOnce(emptyState(), parseRetainFailures(""), h.deps, { apply: true, now: 2_000 });
  expect(h.lines).toEqual([]);
  expect(state.banner).toBeUndefined();
});

test("HR-4: a retain that fails again is reported and left for the next run", async () => {
  const lines: string[] = [];
  const deps = {
    readTranscript: () => "turns\n",
    retain: async () => {
      throw new Error("still down");
    },
    report: (line: string) => lines.push(line),
  };
  const state = await recoverOnce(emptyState(), parseRetainFailures(diagnostic("session-a", 1_000)), deps, { apply: true, now: 2_000 });
  expect(lines).toEqual(["hindsight recovery: retain failed for session session-a: still down"]);
  expect(state.outcomes["session-a"]).toBeUndefined();
});

test("HR-5: outages are announced once, in the banner of the next session", async () => {
  const h = harness({ "session-a": "turns\n", "session-b": "turns\n" });
  const failures = parseRetainFailures(diagnostic("session-a", 1_000) + diagnostic("session-b", 1_500));
  const state = await recoverOnce(emptyState(), failures, h.deps, { apply: true, now: 2_000 });
  expect(state.banner).toBe("hindsight: 2 session write-back failures to recover");

  const taken = takeBanner(state);
  expect(taken.banner).toBe("hindsight: 2 session write-back failures to recover");
  expect(takeBanner(taken.state).banner).toBeUndefined();
});

test("HR-6: a dry run reports what it would do without retaining or saving an outcome", async () => {
  const h = harness({ "session-a": "turns\n" });
  const state = await recoverOnce(emptyState(), parseRetainFailures(diagnostic("session-a", 1_000)), h.deps, { apply: false, now: 2_000 });
  expect(h.retained).toEqual([]);
  expect(h.lines).toEqual(["hindsight recovery: would retain session session-a"]);
  expect(state.outcomes).toEqual({});
});

test("HR-7: only failures newer than the last run are considered, and unparseable lines are skipped", async () => {
  const text = `${diagnostic("old", 1_000)}not json\n${JSON.stringify({ event: "other", session_id: "ignored" })}\n${diagnostic("new", 5_000)}`;
  const failures = parseRetainFailures(text);
  expect(failures.map((f) => f.sessionId)).toEqual(["old", "new"]);

  const h = harness({ old: "a\n", new: "b\n" });
  const prior: RecoveryState = { version: 1, lastRunAt: 2_000, outcomes: {} };
  await recoverOnce(prior, failures, h.deps, { apply: true, now: 6_000 });
  expect(h.retained.map((r) => r.sessionId)).toEqual(["new"]);
});

test("HR-8: state round-trips through disk and a corrupt file reads as empty", () => {
  const path = join(tempDir(), "state.json");
  const state: RecoveryState = { version: 1, lastRunAt: 5, outcomes: { "session-a": "retained" }, banner: "b" };
  saveState(path, state);
  expect(loadState(path)).toEqual(state);

  writeFileSync(path, "{not json");
  expect(loadState(path)).toEqual(emptyState());
});

test("HR-9: the retain is a POST to the bank documents endpoint with an idempotent document id", async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const fetchFn = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  await retainSession({ apiUrl: "http://hs.test:8891/", apiToken: "tok", bank: "coding-agent::proj", fetchFn }, "session-a", "turns\n");

  expect(seen!.url).toBe("http://hs.test:8891/v1/default/banks/coding-agent%3A%3Aproj/documents");
  expect(seen!.init.method).toBe("POST");
  expect((seen!.init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  const body = JSON.parse(String(seen!.init.body));
  expect(body.document_id).toBe("conversation:session-a");
  expect(body.content).toBe("turns\n");
});

test("HR-10: a non-2xx retain throws so the caller can retry it next run", async () => {
  const fetchFn = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
  await expect(retainSession({ apiUrl: "http://hs.test", bank: "b", fetchFn }, "s", "t")).rejects.toThrow("503");
});

test("HR-11: a replayed attention run does not lose the transcript text on disk", async () => {
  // A saved state holds session ids and outcomes only: never transcript content.
  const path = join(tempDir(), "state.json");
  saveState(path, { version: 1, lastRunAt: 1, outcomes: { "session-a": "retained" } });
  expect(readFileSync(path, "utf8")).not.toContain("user:");
});

test("HR-12: a retain that fails again is actually retried by the next run", async () => {
  const lines: string[] = [];
  const retained: string[] = [];
  let down = true;
  const deps = {
    readTranscript: () => "turns\n",
    retain: async (sessionId: string) => {
      if (down) throw new Error("still down");
      retained.push(sessionId);
    },
    report: (line: string) => lines.push(line),
  };
  const failures = () => parseRetainFailures(diagnostic("session-a", 1_000));

  const first = await recoverOnce(emptyState(), failures(), deps, { apply: true, now: 2_000 });
  expect(first.outcomes["session-a"]).toBeUndefined();

  down = false;
  const second = await recoverOnce(first, failures(), deps, { apply: true, now: 3_000 });
  expect(retained).toEqual(["session-a"]);
  expect(second.outcomes["session-a"]).toBe("retained");
});

test("HR-13: a failing session does not stop later failures from being handled", async () => {
  const lines: string[] = [];
  const retained: string[] = [];
  const deps = {
    readTranscript: (sessionId: string) => (sessionId === "session-a" ? "a\n" : "b\n"),
    retain: async (sessionId: string) => {
      if (sessionId === "session-a") throw new Error("still down");
      retained.push(sessionId);
    },
    report: (line: string) => lines.push(line),
  };
  const text = diagnostic("session-a", 1_000) + diagnostic("session-b", 2_000);
  const first = await recoverOnce(emptyState(), parseRetainFailures(text), deps, { apply: true, now: 3_000 });
  expect(retained).toEqual(["session-b"]);
  expect(first.outcomes["session-b"]).toBe("retained");
  // The failed one is still pending, so nothing settled past it is skipped later.
  const second = await recoverOnce(first, parseRetainFailures(text), deps, { apply: true, now: 4_000 });
  expect(second.outcomes["session-a"]).toBeUndefined();
  expect(lines.filter((l) => l.includes("retain failed for session session-a")).length).toBe(2);
});

test("HR-14: the banner is readable once from the saved state file", () => {
  const path = join(tempDir(), "state.json");
  saveState(path, { version: 1, lastRunAt: 1, outcomes: {}, banner: "hindsight: 1 session write-back failure to recover" });
  expect(consumeBanner(path)).toBe("hindsight: 1 session write-back failure to recover");
  expect(consumeBanner(path)).toBeUndefined();
  expect(loadState(path).banner).toBeUndefined();
  expect(loadState(path).lastRunAt).toBe(1);
});

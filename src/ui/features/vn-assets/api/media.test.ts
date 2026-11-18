import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleVNPortrait, handleVNBackground } from "./media";

let dir: string;
let backgroundsDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vn-media-"));
  Bun.env.ANIMA_ROOMS_DIR = join(dir, "rooms");
  backgroundsDir = join(dir, "rooms", "_shared", "vn", "assets", "backgrounds");
  mkdirSync(backgroundsDir, { recursive: true });
});

afterEach(() => {
  delete Bun.env.ANIMA_ROOMS_DIR;
  rmSync(dir, { recursive: true, force: true });
});

test("handleVNBackground serves the file with a last-modified header and no unconditional max-age (SC: re-upload bug)", async () => {
  writeFileSync(join(backgroundsDir, "gus.png"), "fake-png-bytes");
  const res = handleVNBackground("gus");
  expect(res.status).toBe(200);
  expect(res.headers.get("last-modified")).toBeTruthy();
  // The old bug: "public, max-age=3600" told the browser never to even ask
  // again for an hour. no-cache forces revalidation every load instead.
  expect(res.headers.get("cache-control")).toBe("no-cache");
});

test("handleVNBackground returns 304 when if-modified-since is at or after the file's mtime", () => {
  const path = join(backgroundsDir, "gus.png");
  writeFileSync(path, "fake-png-bytes");
  const mtime = new Date("2026-09-13T12:00:00Z");
  utimesSync(path, mtime, mtime);

  const req = new Request("http://x/api/vn/background/gus", {
    headers: { "if-modified-since": mtime.toUTCString() },
  });
  const res = handleVNBackground("gus", undefined, req);
  expect(res.status).toBe(304);
});

test("handleVNBackground serves fresh content (200) when the file changed after if-modified-since — the actual re-upload case", () => {
  const path = join(backgroundsDir, "gus.png");
  writeFileSync(path, "old-bytes");
  const oldMtime = new Date("2026-09-13T12:00:00Z");
  utimesSync(path, oldMtime, oldMtime);

  // Browser cached the old copy at oldMtime, then the file is re-uploaded —
  // the file's mtime advances past what the browser last saw.
  writeFileSync(path, "new-bytes-after-reupload");
  const newMtime = new Date("2026-09-13T13:00:00Z");
  utimesSync(path, newMtime, newMtime);

  const req = new Request("http://x/api/vn/background/gus", {
    headers: { "if-modified-since": oldMtime.toUTCString() },
  });
  const res = handleVNBackground("gus", undefined, req);
  expect(res.status).toBe(200);
});

test("handleVNPortrait: same 304/200 behavior for the portraits path", async () => {
  const portraitsDir = join(dir, "rooms", "_shared", "vn", "assets", "portraits");
  mkdirSync(portraitsDir, { recursive: true });
  const path = join(portraitsDir, "gus.png");
  writeFileSync(path, "fake-portrait-bytes");
  const mtime = new Date("2026-09-13T17:24:00Z");
  utimesSync(path, mtime, mtime);

  const fresh = handleVNPortrait("gus", "neutral");
  expect(fresh.status).toBe(200);
  expect(fresh.headers.get("cache-control")).toBe("no-cache");

  const cached = handleVNPortrait("gus", "neutral", undefined, new Request("http://x", {
    headers: { "if-modified-since": mtime.toUTCString() },
  }));
  expect(cached.status).toBe(304);
});

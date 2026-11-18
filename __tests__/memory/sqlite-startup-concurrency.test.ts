import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const child = join(import.meta.dir, "fixtures", "sqlite-startup-child.ts");
const cli = join(import.meta.dir, "..", "..", "src", "cli.ts");
const talkPreload = join(import.meta.dir, "fixtures", "sqlite-talk-preload.ts");

function spawn(mode: string, dbPath: string, marker: string) {
  const p = Bun.spawn(["bun", child, mode, dbPath, marker], {
    env: { ...process.env, HOME: dirname(dbPath), ANIMA_STATE_DIR: join(dirname(dbPath), "state") },
    stdout: "pipe",
    stderr: "pipe",
  });
  const finished = Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { p, finished };
}

async function exercise(mode: "session" | "event") {
  const dir = mkdtempSync(join(tmpdir(), "anima-sqlite-startup-"));
  const dbPath = join(dir, "sessions.db");
  const marker = join(dir, "attempt");
  let db: Database | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const prepared = spawn("prepare", dbPath, marker);
    const [prepareExit, , prepareError] = await prepared.finished;
    expect({ exit: prepareExit, error: prepareError }).toEqual({ exit: 0, error: "" });

    db = new Database(dbPath);
    db.run("BEGIN IMMEDIATE");
    const worker = spawn(mode, dbPath, marker);
    killTimer = setTimeout(() => worker.p.kill(), 5000);
    const deadline = performance.now() + 3000;
    while (!existsSync(marker) && performance.now() < deadline) await Bun.sleep(5);
    const attempted = existsSync(marker);
    // Hold the independent writer after the child reaches its write. An
    // immediate SQLITE_BUSY fails; a bounded retry survives the release.
    if (attempted) await Bun.sleep(250);
    db.run("ROLLBACK");
    const [exit, stdout, stderr] = await worker.finished;
    expect({ attempted, exit, stdout: stdout.trim(), stderr: stderr.trim() })
      .toEqual({ attempted: true, exit: 0, stdout: "ok", stderr: "" });

    const row = mode === "event"
      ? db.query("SELECT count(*) AS n FROM events WHERE agent='existing-agent'").get()
      : db.query("SELECT count(*) AS n FROM sessions WHERE agent='fresh-agent'").get();
    expect(row).toEqual({ n: 1 });
  } finally {
    if (killTimer) clearTimeout(killTimer);
    try { db?.run("ROLLBACK"); } catch {}
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("new talk session waits for a brief write lock on sessions.db", () => exercise("session"), 6000);
test("existing talk session mail_check waits for a brief write lock on sessions.db", () => exercise("event"), 6000);

async function openDuringWriter(mode: "open-session-only" | "open-event-only") {
  const dir = mkdtempSync(join(tmpdir(), "anima-sqlite-read-startup-"));
  const dbPath = join(dir, "sessions.db");
  const marker = join(dir, "unused");
  let db: Database | undefined;
  let workers: ReturnType<typeof spawn>[] = [];
  try {
    const [prepareExit, , prepareError] = await spawn("prepare", dbPath, marker).finished;
    expect({ exit: prepareExit, error: prepareError }).toEqual({ exit: 0, error: "" });
    db = new Database(dbPath);
    db.run("BEGIN IMMEDIATE");
    const started = performance.now();
    workers = Array.from({ length: 4 }, () => spawn(mode, dbPath, marker));
    const result = await Promise.race([
      Promise.all(workers.map((worker) => worker.finished)).then((children) => ({ completed: true, children })),
      Bun.sleep(1800).then(() => ({ completed: false, children: [] })),
    ]);
    expect(result.completed).toBe(true);
    expect(performance.now() - started).toBeLessThan(1800);
    expect(result.children.map(([exit, stdout, stderr]) => [exit, stdout.trim(), stderr.trim()]))
      .toEqual(Array.from({ length: 4 }, () => [0, "ok", ""]));
  } finally {
    try { db?.run("ROLLBACK"); } catch {}
    for (const worker of workers) worker.p.kill();
    await Promise.all(workers.map((worker) => worker.finished));
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("four SessionStore opens do not wait for a writer when the schema is current", () => openDuringWriter("open-session-only"), 4000);
test("four SqliteStore opens do not wait for a writer when the schema is current", () => openDuringWriter("open-event-only"), 4000);

async function openDuringJournalTransition(store: "entity" | "context" | "shared" | "session-async" | "event-async") {
  const dir = mkdtempSync(join(tmpdir(), "anima-entity-startup-"));
  const dbPath = store === "shared" ? join(dir, "rooms", "_shared", "memory.db") : join(dir, "memory.db");
  mkdirSync(dirname(dbPath), { recursive: true });
  let db: Database | undefined;
  let workers: ReturnType<typeof spawn>[] = [];
  try {
    const preparation = store.endsWith("-async") ? "prepare" : `${store}-prepare`;
    const [prepareExit, , prepareError] = await spawn(preparation, dbPath, join(dir, "unused")).finished;
    expect({ exit: prepareExit, error: prepareError }).toEqual({ exit: 0, error: "" });
    db = new Database(dbPath);
    // Force a journal transition so PRAGMA journal_mode=WAL needs a write
    // lock. The independent writer releases it shortly after every child
    // reaches initialize(), well inside the intended five-second timeout.
    expect(db.query("PRAGMA journal_mode=DELETE").get()).toEqual({ journal_mode: "delete" });
    db.run("BEGIN IMMEDIATE");
    const started = performance.now();
    const markers = Array.from({ length: 4 }, (_, i) => join(dir, `attempt-${i}`));
    workers = markers.map((marker) => spawn(`${store}-open`, dbPath, marker));
    const deadline = performance.now() + 3000;
    while (!markers.every(existsSync) && performance.now() < deadline) await Bun.sleep(5);
    expect(markers.every(existsSync)).toBe(true);
    await Bun.sleep(250);
    db.run("ROLLBACK");
    const result = await Promise.all(workers.map((worker) => worker.finished));
    expect(result.map(([exit, stdout, stderr]) => [exit, stdout.trim(), stderr.trim()]))
      .toEqual(Array.from({ length: 4 }, () => [0, "ok", ""]));
    expect(performance.now() - started).toBeLessThan(3000);
  } finally {
    try { db?.run("ROLLBACK"); } catch {}
    for (const worker of workers) worker.p.kill();
    await Promise.all(workers.map((worker) => worker.finished));
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("four agent-memory opens wait for a brief competing journal-mode lock", () => openDuringJournalTransition("entity"), 6000);
test("four context-engine opens wait for a brief competing journal-mode lock", () => openDuringJournalTransition("context"), 6000);
test("four agents load shared memory through AgentLoader during a brief journal-mode lock", () => openDuringJournalTransition("shared"), 6000);
test("four asynchronous session-store opens survive a brief journal-mode lock", () => openDuringJournalTransition("session-async"), 6000);
test("four asynchronous event-store opens survive a brief journal-mode lock", () => openDuringJournalTransition("event-async"), 6000);

async function schemaCreationWaits(kind: "session" | "event" | "shared"): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "anima-sqlite-ddl-"));
    const dbPath = join(dir, "store.db");
    const marker = join(dir, "schema-attempt");
    let db: Database | undefined;
    let worker: ReturnType<typeof spawn> | undefined;
    try {
      db = new Database(dbPath);
      db.run("PRAGMA journal_mode=WAL");
      db.run("BEGIN IMMEDIATE");
      worker = spawn(`ddl-${kind}`, dbPath, marker);
      const deadline = performance.now() + 3000;
      while (!existsSync(marker) && performance.now() < deadline && worker.p.exitCode === null) await Bun.sleep(5);
      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf8")).toBe("5000");
      await Bun.sleep(250);
      expect(worker.p.exitCode).toBeNull();
      db.run("ROLLBACK");
      const [exit, stdout, stderr] = await worker.finished;
      expect([exit, stdout.trim(), stderr.trim()]).toEqual([0, "ok", ""]);
    } finally {
      try { db?.run("ROLLBACK"); } catch {}
      worker?.p.kill();
      await worker?.finished;
      db?.close();
      rmSync(dir, { recursive: true, force: true });
    }
}

test("session schema creation waits for a competing writer after WAL setup", () => schemaCreationWaits("session"), 6000);
test("event schema creation waits for a competing writer after WAL setup", () => schemaCreationWaits("event"), 6000);
test("shared schema creation waits for a competing writer after WAL setup", () => schemaCreationWaits("shared"), 6000);

test("agent-memory journal-mode retry is bounded when the competing writer stays", async () => {
  const dir = mkdtempSync(join(tmpdir(), "anima-entity-timeout-"));
  const dbPath = join(dir, "memory.db");
  let db: Database | undefined;
  let worker: ReturnType<typeof spawn> | undefined;
  try {
    const [prepareExit] = await spawn("entity-prepare", dbPath, join(dir, "unused")).finished;
    expect(prepareExit).toBe(0);
    db = new Database(dbPath);
    db.query("PRAGMA journal_mode=DELETE").get();
    db.run("BEGIN IMMEDIATE");
    const started = performance.now();
    worker = spawn("entity-open", dbPath, join(dir, "attempt"));
    const [exit, , stderr] = await worker.finished;
    const elapsed = performance.now() - started;
    expect(exit).toBe(1);
    expect(JSON.parse(stderr).code).toMatch(/^SQLITE_BUSY/);
    expect(elapsed).toBeGreaterThanOrEqual(4900);
    expect(elapsed).toBeLessThan(6500);
  } finally {
    try { db?.run("ROLLBACK"); } catch {}
    worker?.p.kill();
    await worker?.finished;
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 8000);

test("agent-memory startup immediately reports a non-SQLite database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "anima-entity-invalid-"));
  const dbPath = join(dir, "memory.db");
  try {
    await Bun.write(dbPath, "not a sqlite database");
    const started = performance.now();
    const [exit, , stderr] = await spawn("entity-open", dbPath, join(dir, "attempt")).finished;
    expect(exit).toBe(1);
    expect(JSON.parse(stderr).code).toBe("SQLITE_NOTADB");
    expect(performance.now() - started).toBeLessThan(1500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 4000);

test("regression: four real talk starts survive a brief sessions database journal lock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "anima-talk-startup-"));
  const dbPath = join(dir, "sessions.db");
  const animaHome = join(dir, ".anima");
  const rooms = join(animaHome, "rooms");
  let db: Database | undefined;
  let workers: ReturnType<typeof spawn>[] = [];
  try {
    const [prepareExit] = await spawn("prepare", dbPath, join(dir, "unused")).finished;
    expect(prepareExit).toBe(0);
    for (let i = 0; i < 4; i++) {
      const name = `test-agent-${i}`;
      const room = join(rooms, name);
      mkdirSync(room, { recursive: true });
      writeFileSync(join(room, "gene.md"), "Test agent\n");
      writeFileSync(join(room, "config.yaml"), `identity:
  name: ${name}
  label: Test agent
provider:
  type: claude
policy:
  allowedRoots: []
session:
  defaultMode: plan
boot:
  gene: gene.md
  sessionContext:
    - path: gene.md
`);
    }
    db = new Database(dbPath);
    expect(db.query("PRAGMA journal_mode=DELETE").get()).toEqual({ journal_mode: "delete" });
    db.run("BEGIN IMMEDIATE");
    const started = performance.now();
    const markers = Array.from({ length: 4 }, (_, i) => join(dir, `talk-attempt-${i}`));
    workers = markers.map((marker, i) => {
      const p = Bun.spawn([
        process.execPath, "--preload", talkPreload, cli, "talk",
        "--agent", `test-agent-${i}`, "--message", "test", "--provider", "claude",
      ], {
        cwd: dir,
        env: {
          PATH: process.env.PATH, HOME: dir, ANIMA_HOME: animaHome,
          ANIMA_ROOMS_DIR: rooms, ANIMA_SESSIONS_DB: dbPath,
          ANIMA_AGENT_SOURCE_DIR: join(dir, "no-sources"), ANIMA_SUBSTRATE_DIR: join(dir, "no-substrate"),
          SQLITE_ATTEMPT_MARKER: marker,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      return { p, finished: Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]) };
    });
    const deadline = performance.now() + 3000;
    while (!markers.every(existsSync) && performance.now() < deadline) await Bun.sleep(5);
    expect(markers.every(existsSync)).toBe(true);
    await Bun.sleep(250);
    db.run("ROLLBACK");
    const result = await Promise.all(workers.map((worker) => worker.finished));
    expect(result.map(([exit, stdout, stderr]) => ({ exit, mockReply: stdout.includes("local mock"), locked: /database is locked/i.test(stderr) })))
      .toEqual(Array.from({ length: 4 }, () => ({ exit: 0, mockReply: true, locked: false })));
    expect(performance.now() - started).toBeLessThan(3000);
  } finally {
    try { db?.run("ROLLBACK"); } catch {}
    for (const worker of workers) worker.p.kill();
    await Promise.all(workers.map((worker) => worker.finished));
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 6000);

async function cliWaits(command: "session" | "check-mail"): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "anima-cli-wal-"));
    const dbPath = join(dir, "sessions.db");
    const animaHome = join(dir, ".anima");
    const rooms = join(animaHome, "rooms");
    const agentDir = join(rooms, "test-agent");
    const marker = join(dir, "attempt");
    let db: Database | undefined;
    let worker: { p: ReturnType<typeof Bun.spawn>; finished: Promise<[number, string, string]> } | undefined;
    try {
      const [prepareExit] = await spawn("prepare", dbPath, join(dir, "unused")).finished;
      expect(prepareExit).toBe(0);
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, "gene.md"), "Test agent\n");
      writeFileSync(join(agentDir, "config.yaml"), `identity:
  name: test-agent
  label: Test agent
provider:
  type: claude
policy:
  allowedRoots: []
session:
  defaultMode: plan
boot:
  gene: gene.md
  sessionContext:
    - path: gene.md
`);
      db = new Database(dbPath);
      expect(db.query("PRAGMA journal_mode=DELETE").get()).toEqual({ journal_mode: "delete" });
      db.run("BEGIN IMMEDIATE");
      const args = command === "session" ? ["session", "test-agent"] : ["check-mail", "--agent", "test-agent"];
      const p = Bun.spawn([process.execPath, "--preload", talkPreload, cli, ...args], {
        cwd: dir,
        env: {
          PATH: process.env.PATH, HOME: dir, ANIMA_HOME: animaHome,
          ANIMA_ROOMS_DIR: rooms, ANIMA_SESSIONS_DB: dbPath,
          ANIMA_AGENT_SOURCE_DIR: join(dir, "no-sources"), ANIMA_SUBSTRATE_DIR: join(dir, "no-substrate"),
          SQLITE_ATTEMPT_MARKER: marker,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      worker = { p, finished: Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]) };
      const deadline = performance.now() + 3000;
      while (!existsSync(marker) && performance.now() < deadline) await Bun.sleep(5);
      expect(existsSync(marker)).toBe(true);
      await Bun.sleep(250);
      db.run("ROLLBACK");
      const [exit, stdout, stderr] = await worker.finished;
      expect({ exit, locked: /database is locked/i.test(stderr), output: stdout.includes(command === "session" ? "sessionId" : "unread meeting mail") })
        .toEqual({ exit: 0, locked: false, output: true });
    } finally {
      try { db?.run("ROLLBACK"); } catch {}
      worker?.p.kill();
      await worker?.finished;
      db?.close();
      rmSync(dir, { recursive: true, force: true });
    }
}

test("real session CLI waits for a brief sessions database journal lock", () => cliWaits("session"), 6000);
test("real check-mail CLI waits for a brief sessions database journal lock", () => cliWaits("check-mail"), 6000);

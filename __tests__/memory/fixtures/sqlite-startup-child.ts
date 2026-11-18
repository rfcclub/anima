import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { SessionManager } from "../../../src/session/manager";
import { SessionStore } from "../../../src/memory/session-store";
import { SqliteStore } from "../../../src/memory/sqlite-store";
import { AnimaEntityStore } from "../../../src/memory/anima-entity-store";
import { BunContextEngineImpl } from "../../../src/memory/context-store";
import { SharedMemoryAdapter } from "../../../src/memory/shared-adapter";
import { AgentLoader } from "../../../src/agents/loader";

const [mode, dbPath, marker] = process.argv.slice(2);

try {
  if (mode === "ddl-session" || mode === "ddl-event" || mode === "ddl-shared") {
    for (const method of ["run", "exec"] as const) {
      const original = Database.prototype[method];
      (Database.prototype as any)[method] = function(this: Database, sql: string, ...bindings: unknown[]) {
        if (this.filename === dbPath && /CREATE TABLE IF NOT EXISTS (sessions|events|memories)\s*\(/i.test(sql)) {
          const timeout = this.query("PRAGMA busy_timeout").get() as { timeout: number };
          writeFileSync(marker, String(timeout.timeout));
        }
        return Reflect.apply(original, this, [sql, ...bindings]);
      };
    }
    if (mode === "ddl-session") (await SessionStore.open(dbPath)).close();
    else if (mode === "ddl-event") await SqliteStore.open(dbPath);
    else (await SharedMemoryAdapter.open(dbPath)).close();
    console.log("ok");
    process.exit(0);
  }
  if (mode === "session-async-open" || mode === "event-async-open") {
    writeFileSync(marker, "about-to-open-store");
    if (mode === "session-async-open") {
      const open = (SessionStore as unknown as { open?: (path: string) => Promise<SessionStore> }).open;
      const store = open ? await open(dbPath) : new SessionStore(dbPath);
      store.close();
    } else {
      const open = (SqliteStore as unknown as { open?: (path: string) => Promise<SqliteStore> }).open;
      if (open) await open(dbPath);
      else new SqliteStore(dbPath);
    }
    console.log("ok");
    process.exit(0);
  }
  if (mode === "shared-prepare") {
    const store = new SharedMemoryAdapter(dbPath);
    store.close();
    console.log("ok");
    process.exit(0);
  }
  if (mode === "shared-open") {
    const roomsDir = dirname(dirname(dbPath));
    const name = `test-${basename(marker)}`;
    const room = join(roomsDir, name);
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
memory:
  type: shared
`);
    writeFileSync(marker, "about-to-load-agent");
    const agent = await new AgentLoader({
      roomsDir,
      agentSourceDir: join(roomsDir, "no-agent-sources"),
      substrateDir: join(roomsDir, "no-substrate"),
      log: () => {},
    }).load(name);
    (agent.memoryAdapter as SharedMemoryAdapter).close();
    agent.contextEngine?.dispose();
    console.log("ok");
    process.exit(0);
  }
  if (mode === "context-prepare" || mode === "context-open") {
    const engine = new BunContextEngineImpl(dbPath);
    if (mode === "context-open") writeFileSync(marker, "about-to-open-context");
    await engine.initialize("test-agent", "anima");
    engine.dispose();
    console.log("ok");
    process.exit(0);
  }
  if (mode === "entity-prepare" || mode === "entity-open") {
    const store = new AnimaEntityStore(dbPath);
    if (mode === "entity-open") writeFileSync(marker, "about-to-open-entity");
    await store.initialize();
    store.close();
    console.log("ok");
    process.exit(0);
  }
  if (mode === "open-session-only") {
    new SessionStore(dbPath);
    console.log("ok");
    process.exit(0);
  }
  if (mode === "open-event-only") {
    new SqliteStore(dbPath);
    console.log("ok");
    process.exit(0);
  }
  const events = new SqliteStore(dbPath);
  const sessions = new SessionStore(dbPath);
  const manager = new SessionManager({ store: sessions });

  if (mode === "prepare") {
    manager.openSession("existing-agent", "talk");
  } else if (mode === "event") {
    const session = manager.openSession("existing-agent", "talk");
    writeFileSync(marker, "about-to-append");
    events.append("existing-agent", {
      timestamp: "2026-11-06T00:00:00.000Z",
      type: "mail_check",
      sessionId: session.id,
      unread: 0,
    });
  } else if (mode === "session") {
    writeFileSync(marker, "about-to-open-session");
    manager.openSession("fresh-agent", "talk");
  } else {
    throw new Error(`unexpected mode ${mode}`);
  }
  console.log("ok");
} catch (error) {
  const e = error as Error & { code?: string };
  console.error(JSON.stringify({ message: e.message, code: e.code, stack: e.stack }));
  process.exitCode = 1;
}

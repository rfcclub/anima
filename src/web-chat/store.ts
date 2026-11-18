import { Database } from "bun:sqlite";
import { join } from "node:path";
import type {
  ChatConversation,
  ChatEvent,
  ChatRequest,
  RefusalReceipt,
} from "./types";

export { privateDirectory, privateFile } from "./private-fs";
import { privateDirectory, privateFile } from "./private-fs";
export class ChatStore {
  readonly db: Database;
  readonly root: string;
  constructor(root: string) {
    this.root = privateDirectory(root);
    const file = join(this.root, "state.db");
    privateFile(file);
    this.db = new Database(file, { strict: true });
    this.db.exec(
      "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, scope TEXT NOT NULL UNIQUE, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, request TEXT NOT NULL, at INTEGER NOT NULL, state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS refusals (id TEXT PRIMARY KEY, owner TEXT NOT NULL, at INTEGER NOT NULL, body TEXT NOT NULL);",
    );
  }
  conversations(): ChatConversation[] {
    return this.db
      .query("SELECT body FROM conversations")
      .all()
      .map((v: any) => JSON.parse(v.body));
  }
  conversation(id: string): ChatConversation | undefined {
    const row = this.db
      .query("SELECT body FROM conversations WHERE id=?")
      .get(id) as any;
    return row ? JSON.parse(row.body) : undefined;
  }
  putConversation(value: ChatConversation) {
    this.db
      .query(
        "INSERT INTO conversations VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(value.id, JSON.stringify(value));
  }
  requests(): ChatRequest[] {
    return this.db
      .query("SELECT body FROM requests")
      .all()
      .map((v: any) => JSON.parse(v.body));
  }
  request(id: string): ChatRequest | undefined {
    const row = this.db
      .query("SELECT body FROM requests WHERE id=?")
      .get(id) as any;
    return row ? JSON.parse(row.body) : undefined;
  }
  byScope(scope: string): ChatRequest | undefined {
    const row = this.db
      .query("SELECT body FROM requests WHERE scope=?")
      .get(scope) as any;
    return row ? JSON.parse(row.body) : undefined;
  }
  putRequest(value: ChatRequest, scope?: string) {
    if (scope)
      this.db
        .query("INSERT INTO requests VALUES (?,?,?)")
        .run(value.id, scope, JSON.stringify(value));
    else
      this.db
        .query("UPDATE requests SET body=? WHERE id=?")
        .run(JSON.stringify(value), value.id);
  }
  putRefusal(value: RefusalReceipt) {
    const owner = JSON.stringify([value.owner.agent, value.owner.session]);
    this.db
      .query("INSERT INTO refusals VALUES (?,?,?,?)")
      .run(value.id, owner, value.at, JSON.stringify(value));
    this.db
      // Bounded like events: refusal spam cannot grow durable state.
      .query(
        "DELETE FROM refusals WHERE owner=? AND id NOT IN (SELECT id FROM refusals WHERE owner=? ORDER BY at DESC, rowid DESC LIMIT 128)",
      )
      .run(owner, owner);
  }
  refusals(agent: string, session: string): RefusalReceipt[] {
    return this.db
      .query("SELECT body FROM refusals WHERE owner=? ORDER BY at, rowid")
      .all(JSON.stringify([agent, session]))
      .map((v: any) => JSON.parse(v.body));
  }
  event(value: ChatRequest) {
    this.db
      .query("INSERT INTO events(request,at,state) VALUES (?,?,?)")
      .run(value.id, value.updatedAt, value.state);
    this.db
      // Opt-in requires approval of this automatic retention policy.
      .query(
        "DELETE FROM events WHERE request=? AND id NOT IN (SELECT id FROM events WHERE request=? ORDER BY id DESC LIMIT 128)",
      )
      .run(value.id, value.id);
  }
  events(id: string, after = 0): ChatEvent[] {
    return this.db
      .query(
        "SELECT id AS cursor,at,state FROM events WHERE request=? AND id>? ORDER BY id",
      )
      .all(id, after) as ChatEvent[];
  }
  lastCursor(id: string): number {
    return Number(
      (
        this.db
          .query(
            "SELECT COALESCE(MAX(id),0) AS cursor FROM events WHERE request=?",
          )
          .get(id) as any
      ).cursor,
    );
  }
  hasCursor(id: string, cursor: number): boolean {
    return !!this.db
      .query("SELECT 1 FROM events WHERE request=? AND id=?")
      .get(id, cursor);
  }
  forgetConversation(id: string) {
    this.transaction(() => {
      // Opt-in requires approval of this automatic retention policy.
      this.db
        .query(
          "DELETE FROM events WHERE request IN (SELECT id FROM requests WHERE json_extract(body,'$.conversationId')=?)",
        )
        .run(id);
      this.db
        .query(
          "DELETE FROM requests WHERE json_extract(body,'$.conversationId')=?",
        )
        .run(id);
      this.db
        .query(
          "DELETE FROM refusals WHERE json_extract(body,'$.conversationId')=?",
        )
        .run(id);
      this.db.query("DELETE FROM conversations WHERE id=?").run(id);
    });
  }
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
  close() {
    this.db.close();
  }
}

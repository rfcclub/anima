import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

export interface ReviewSubject {
  repo: string; number: number; headSha: string; baseSha: string; appLogin: string;
}
export interface ReviewEvidence { reviewId: number; headSha: string; appLogin: string }
export type ReviewJournalState = "reserved" | "sending" | "created" | "rejected" | "uncertain" | "bound" | "unbound";
export interface ReviewAttempt { id: string; subject: ReviewSubject; state: ReviewJournalState; review?: ReviewEvidence }
export interface ReviewBaseBinding extends ReviewEvidence { baseSha: string }
const sha = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{40}$/.test(v);
const positive = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
function subjectKey(v: unknown): string {
  if (!object(v) || typeof v.repo !== "string" || !/^rfcclub\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(v.repo)
    || !positive(v.number) || !sha(v.headSha) || !sha(v.baseSha) || typeof v.appLogin !== "string"
    || !/^[a-z0-9][a-z0-9-]{0,99}\[bot\]$/i.test(v.appLogin)) throw Error("journal_subject");
  return JSON.stringify([v.repo.toLowerCase(), v.number, v.headSha, v.baseSha, v.appLogin.toLowerCase()]);
}
function reviewEvidence(v: unknown, subject: ReviewSubject): ReviewEvidence {
  if (!object(v) || !positive(v.reviewId) || v.headSha !== subject.headSha
    || typeof v.appLogin !== "string" || v.appLogin.toLowerCase() !== subject.appLogin.toLowerCase()) throw Error("journal_review");
  return { reviewId: v.reviewId, headSha: v.headSha, appLogin: v.appLogin };
}
const next: Record<ReviewJournalState, readonly ReviewJournalState[]> = {
  reserved: ["sending"], sending: ["created", "rejected", "uncertain"], created: ["bound", "unbound"],
  rejected: [], uncertain: [], bound: [], unbound: [],
};

/** Caller-owned DB. API is insert-only; triggers refuse UPDATE/DELETE, not INSERT OR REPLACE/schema changes.
 * Same-UID custody and authentication remain unproved; reconstructed legal histories can be accepted. */
export class ReviewJournal {
  constructor(private readonly db: Database) {
    db.exec(`PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS review_subjects (key TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS review_events (attempt_id TEXT NOT NULL REFERENCES review_subjects(id),
        seq INTEGER NOT NULL CHECK(seq>0), state TEXT NOT NULL, payload TEXT, review_id INTEGER,
        PRIMARY KEY(attempt_id,seq));
      CREATE UNIQUE INDEX IF NOT EXISTS review_actual_id ON review_events(review_id) WHERE state='created';
      CREATE TRIGGER IF NOT EXISTS review_subjects_update BEFORE UPDATE ON review_subjects BEGIN SELECT RAISE(ABORT,'journal_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS review_subjects_delete BEFORE DELETE ON review_subjects BEGIN SELECT RAISE(ABORT,'journal_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS review_events_update BEFORE UPDATE ON review_events BEGIN SELECT RAISE(ABORT,'journal_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS review_events_delete BEFORE DELETE ON review_events BEGIN SELECT RAISE(ABORT,'journal_immutable'); END;`);
  }
  reserve(subject: ReviewSubject): ReviewAttempt | null {
    const key = subjectKey(subject), [repo, number, headSha, baseSha, appLogin] = JSON.parse(key);
    const copy: ReviewSubject = { repo, number, headSha, baseSha, appLogin };
    return this.db.transaction(() => {
      const id = randomUUID();
      const inserted = this.db.query("INSERT OR IGNORE INTO review_subjects(key,id,payload) VALUES(?,?,?)").run(key, id, JSON.stringify(copy));
      if (!inserted.changes) return null;
      this.db.query("INSERT INTO review_events(attempt_id,seq,state) VALUES(?,1,'reserved')").run(id);
      return { id, subject: copy, state: "reserved" as const };
    }).immediate();
  }
  get(id: string): ReviewAttempt | null {
    const row = this.db.query("SELECT key,payload FROM review_subjects WHERE id=?").get(id) as {key:string;payload:string} | null;
    if (!row) return null;
    try {
      const subject = JSON.parse(row.payload) as ReviewSubject;
      if (subjectKey(subject) !== row.key) throw Error();
      const rows = this.db.query("SELECT seq,state,payload,review_id FROM review_events WHERE attempt_id=? ORDER BY seq").all(id) as Array<{seq:number;state:ReviewJournalState;payload:string|null;review_id:number|null}>;
      let state: ReviewJournalState = "reserved", review: ReviewEvidence | undefined;
      if (!rows.length) throw Error();
      for (const [index, event] of rows.entries()) {
        if (event.seq !== index + 1 || (index === 0 ? event.state !== "reserved" : !next[state].includes(event.state))) throw Error();
        if (event.state === "created") {
          review = reviewEvidence(JSON.parse(event.payload ?? "null"), subject);
          if (review.reviewId !== event.review_id) throw Error();
        } else if (event.payload !== null || event.review_id !== null) throw Error();
        state = event.state;
      }
      return { id, subject, state, ...(review ? { review } : {}) };
    } catch { throw Error("journal_invalid"); }
  }
  append(id: string, state: Exclude<ReviewJournalState, "reserved">, review?: ReviewEvidence): void {
    this.db.transaction(() => {
      const before = this.get(id);
      if (!before || !next[before.state].includes(state)) throw Error("journal_transition");
      const evidence = state === "created" ? reviewEvidence(review, before.subject) : undefined;
      if (state !== "created" && review !== undefined) throw Error("journal_review");
      const count = this.db.query("SELECT COUNT(*) AS n FROM review_events WHERE attempt_id=?").get(id) as {n:number};
      this.db.query("INSERT INTO review_events(attempt_id,seq,state,payload,review_id) VALUES(?,?,?,?,?)")
        .run(id, count.n + 1, state, evidence ? JSON.stringify(evidence) : null, evidence?.reviewId ?? null);
    }).immediate();
  }
  find(subject: ReviewSubject): ReviewAttempt | null {
    const row = this.db.query("SELECT id FROM review_subjects WHERE key=?").get(subjectKey(subject)) as {id:string} | null;
    return row ? this.get(row.id) : null;
  }
  bindings(): ReviewBaseBinding[] {
    const rows = this.db.query("SELECT id FROM review_subjects ORDER BY id").all() as Array<{id:string}>;
    return rows.map(row => this.get(row.id)!).filter(attempt => attempt.state === "bound")
      .map(attempt => ({ ...attempt.review!, baseSha: attempt.subject.baseSha }));
  }
}

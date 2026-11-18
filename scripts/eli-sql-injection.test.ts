import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// eli-recall.sh / eli-remember.sh interpolate shell variables into SQL.
// recall-agent.sh / remember-agent.sh already escape single quotes and
// validate numbers; these two did not. Every test runs the real script against a throwaway HOME whose
// eli memory.db carries a `canary` table — an injected `DROP TABLE canary`
// that lands means the payload executed.

const SCRIPTS = join(import.meta.dir);
const RECALL = join(SCRIPTS, "eli-recall.sh");
const REMEMBER = join(SCRIPTS, "eli-remember.sh");
const RECALL_AGENT = join(SCRIPTS, "recall-agent.sh");

const NEURONS_DDL = `CREATE TABLE neurons (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, content TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}', access_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  scope TEXT, tags TEXT NOT NULL DEFAULT '[]', source TEXT,
  confidence REAL NOT NULL DEFAULT 0.5);`;
const FTS_DDL = `CREATE VIRTUAL TABLE neurons_fts USING fts5(content, content='neurons', content_rowid='rowid');
CREATE TRIGGER neurons_ai AFTER INSERT ON neurons BEGIN
  INSERT INTO neurons_fts(rowid, content) VALUES (new.rowid, new.content);
END;`;

let home: string;
let db: string;

function sqlite(sql: string): string {
  const r = Bun.spawnSync(["sqlite3", db, "-cmd", ".mode json", sql]);
  if (r.exitCode !== 0) throw new Error(`sqlite3 failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function setup(withFts: boolean) {
  home = mkdtempSync(join(tmpdir(), "eli-sqli-"));
  mkdirSync(join(home, ".anima/agents/eli"), { recursive: true });
  db = join(home, ".anima/agents/eli/memory.db");
  sqlite(NEURONS_DDL + (withFts ? FTS_DDL : "") + "CREATE TABLE canary (x);INSERT INTO canary VALUES (1);");
  sqlite(
    "INSERT INTO neurons (id,type,content,created_at,updated_at,scope,source,confidence) " +
      "VALUES ('seed','episode','bob''s over-engineered pilots','2026-01-01','2026-01-01','preference','test',0.9);",
  );
}

function run(script: string, args: string[], env: Record<string, string> = {}) {
  const r = Bun.spawnSync(["bash", script, ...args], { env: { ...process.env, HOME: home, ...env } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const canaryAlive = () => sqlite("SELECT count(*) AS n FROM canary;").includes('"n":1');
const DROP = "'; DROP TABLE canary; --";

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("eli-recall.sh", () => {
  describe("LIKE fallback (no FTS table)", () => {
    beforeEach(() => setup(false));

    test("a query containing an apostrophe still matches instead of breaking the SQL", () => {
      const r = run(RECALL, ["bob's over"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("over-engineered pilots");
    });

    test("an injected DROP TABLE in the query is treated as text, not executed", () => {
      run(RECALL, [`x${DROP}`]);
      expect(canaryAlive()).toBe(true);
    });
  });

  describe("FTS branch", () => {
    beforeEach(() => setup(true));

    test("an injected DROP TABLE in an FTS token is treated as text, not executed", () => {
      run(RECALL, [`x${DROP}`]);
      expect(canaryAlive()).toBe(true);
    });

    test("an apostrophe in an FTS token does not break the query", () => {
      const r = run(RECALL, ["bob's"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("over-engineered pilots");
    });

    // Not a security hole (see the recall-agent.sh note below) but a real
    // regression: without the escape the FTS branch errors on an apostrophe
    // and OR-of-tokens matching silently degrades to a contiguous LIKE.
    test("OR-of-tokens matching still works when one token has an apostrophe", () => {
      const r = run(RECALL, ["bob's pilots"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("over-engineered pilots");
    });
  });

  describe("topK validation", () => {
    beforeEach(() => setup(false));

    test("a non-numeric --topK is rejected and nothing runs", () => {
      const r = run(RECALL, ["pilots", "--topK", "1; DROP TABLE canary"]);
      expect(r.code).not.toBe(0);
      expect(r.err).toContain("invalid_topK");
      expect(canaryAlive()).toBe(true);
    });

    test("a non-numeric TOPK env var is rejected too", () => {
      const r = run(RECALL, ["pilots"], { TOPK: "1; DROP TABLE canary" });
      expect(r.code).not.toBe(0);
      expect(canaryAlive()).toBe(true);
    });

    test("a numeric --topK still works", () => {
      const r = run(RECALL, ["pilots", "--topK", "3"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("over-engineered pilots");
    });
  });
});

describe("eli-remember.sh", () => {
  beforeEach(() => setup(false));

  test("an apostrophe in --scope is stored literally instead of breaking the INSERT", () => {
    const r = run(REMEMBER, ["--content", "hello", "--scope", "user's-pref"]);
    expect(r.code).toBe(0);
    expect(sqlite("SELECT scope FROM neurons WHERE content='hello';")).toContain("user's-pref");
  });

  test.each([
    ["--type", `episode${DROP}`],
    ["--scope", `obs${DROP}`],
    ["--source", `src${DROP}`],
    ["--tags", `a${DROP}`],
  ])("an injected DROP TABLE in %s is stored as text, not executed", (flag, payload) => {
    run(REMEMBER, ["--content", "hello", flag, payload]);
    expect(canaryAlive()).toBe(true);
    expect(sqlite("SELECT count(*) AS n FROM neurons WHERE content='hello';")).toContain('"n":1');
  });

  test("a non-numeric --confidence is rejected and nothing is written", () => {
    const r = run(REMEMBER, ["--content", "hello", "--confidence", "1); DROP TABLE canary; --"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("invalid_confidence");
    expect(canaryAlive()).toBe(true);
    expect(sqlite("SELECT count(*) AS n FROM neurons WHERE content='hello';")).toContain('"n":0');
  });

  test("a normal write with a numeric --confidence still works", () => {
    const r = run(REMEMBER, ["--content", "plain note", "--confidence", "0.9", "--tags", "a,b"]);
    expect(r.code).toBe(0);
    expect(sqlite("SELECT confidence, tags FROM neurons WHERE content='plain note';")).toContain("0.9");
  });
});

// recall-agent.sh is the generalized (any-agent) recall script; its LIKE
// fallback already escaped quotes but the FTS branch interpolated the
// tokenised query into MATCH '...' raw. Its DB path is ~/.anima/agents/<agent>/memory.db, so the
// throwaway HOME from setup() (which creates agents/eli) serves as agent "eli".
describe("recall-agent.sh", () => {
  beforeEach(() => setup(true));

  test("an injected DROP TABLE in an FTS token is treated as text, not executed", () => {
    run(RECALL_AGENT, ["eli", `x${DROP}`]);
    expect(canaryAlive()).toBe(true);
  });

  test("an apostrophe in an FTS token does not break the query", () => {
    const r = run(RECALL_AGENT, ["eli", "bob's"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("over-engineered pilots");
  });

  // The tokenised FTS query always starts with an unterminated `"` once a
  // quote closes the SQL literal early, so sqlite errors on the first
  // statement and never reaches a stacked one. This whitespace-free payload
  // (no spaces, so it survives tokenising as ONE token) documents that.
  test("a whitespace-free stacked-statement payload does not run in the FTS branch", () => {
    run(RECALL_AGENT, ["eli", "x';DROP/**/TABLE/**/canary;--"]);
    expect(canaryAlive()).toBe(true);
  });

  // What the missing escape really costs: the FTS branch errors on any
  // apostrophe, silently degrading to the LIKE fallback and losing the
  // documented OR-of-tokens semantics. "bob's pilots" is not a contiguous
  // substring of the stored text, so only the FTS branch can match it.
  test("OR-of-tokens matching still works when one token has an apostrophe", () => {
    const r = run(RECALL_AGENT, ["eli", "bob's pilots"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("over-engineered pilots");
  });
});

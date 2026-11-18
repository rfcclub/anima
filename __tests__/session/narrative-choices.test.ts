/**
 * Regression tests for the narrative choice store used by POST /api/vn/choice.
 *
 * Guards two bugs:
 * 1. getNarrativeChoices / getChoicesForBranch passed query params as
 *    db.query(sql, params).all() — bun:sqlite ignores query()'s second
 *    argument, so the WHERE ? bound NULL and always returned [] (which also
 *    made every choice auto-create a new branch).
 * 2. recordChoice with turnId 0 violated the NOT NULL FK on turn_id.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/memory/session-store";

let dir: string;
let store: SessionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vn-choices-"));
  store = new SessionStore(join(dir, "sessions.db"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("narrative choices", () => {
  test("recordChoice → getNarrativeChoices round-trips", () => {
    const session = store.createSession("bruno", "ui");
    const turn = store.appendTurn(session.id, "assistant", "Pick one.");
    const branch = store.createBranch(session.id, "main");

    store.recordChoice({
      id: "choice-1",
      sessionId: session.id,
      branchId: branch.id,
      parentBranchId: null,
      turnId: turn.id,
      label: "Go to the garden",
      value: "go_garden",
      choiceIndex: 0,
    });

    const choices = store.getNarrativeChoices(session.id);
    expect(choices).toHaveLength(1);
    expect(choices[0].value).toBe("go_garden");
    expect(choices[0].turnId).toBe(turn.id);
    expect(choices[0].branchId).toBe(branch.id);
  });

  test("getChoicesForBranch scopes to the branch", () => {
    const session = store.createSession("bruno", "ui");
    const turn = store.appendTurn(session.id, "assistant", "Pick one.");
    const a = store.createBranch(session.id, "a");
    const b = store.createBranch(session.id, "b");

    store.recordChoice({
      id: "choice-a",
      sessionId: session.id,
      branchId: a.id,
      parentBranchId: null,
      turnId: turn.id,
      label: "A",
      value: "a",
      choiceIndex: 0,
    });

    expect(store.getChoicesForBranch(a.id)).toHaveLength(1);
    expect(store.getChoicesForBranch(b.id)).toHaveLength(0);
  });

  test("choices for one session do not leak into another", () => {
    const s1 = store.createSession("bruno", "ui");
    const s2 = store.createSession("lena", "ui");
    const turn = store.appendTurn(s1.id, "assistant", "Pick.");

    store.recordChoice({
      id: "choice-s1",
      sessionId: s1.id,
      branchId: null,
      parentBranchId: null,
      turnId: turn.id,
      label: "X",
      value: "x",
      choiceIndex: 0,
    });

    expect(store.getNarrativeChoices(s1.id)).toHaveLength(1);
    expect(store.getNarrativeChoices(s2.id)).toHaveLength(0);
  });
});

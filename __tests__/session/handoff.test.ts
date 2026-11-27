import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HANDOFF_ARCHIVE_KEEP,
  HANDOFF_FILE,
  HANDOFF_PROMPT,
  handoffArchiveDir,
  handoffSessionContext,
  readHandoff,
  withHandoffContext,
  writeHandoff,
} from "../../src/session/handoff";

function makeRoom() {
  return mkdtempSync(join(tmpdir(), "handoff-"));
}

describe("handoff file", () => {
  test("the prompt tells the agent where the handoff goes, not what to say", () => {
    expect(HANDOFF_PROMPT).toContain(HANDOFF_FILE);
    expect(HANDOFF_PROMPT).toContain("what the next session must not forget");
  });

  test("a room without a handoff has none", async () => {
    const room = makeRoom();
    expect(await readHandoff(room)).toBeUndefined();
    expect(await handoffSessionContext(room)).toBeUndefined();
  });

  test("a written handoff is read back and becomes boot context", async () => {
    const room = makeRoom();
    await writeHandoff(room, "I was rewriting the reset path.");
    expect(await readHandoff(room)).toBe("I was rewriting the reset path.");
    const context = await handoffSessionContext(room);
    expect(context?.path).toBe(HANDOFF_FILE);
    expect(context?.label).toBe("Handoff");
    expect(context?.content).toContain("rewriting the reset path");
  });

  test("an empty handoff is no handoff", async () => {
    const room = makeRoom();
    await writeHandoff(room, "   \n");
    expect(await readHandoff(room)).toBeUndefined();
  });

  test("replacing the handoff keeps the previous one as a dated copy", async () => {
    const room = makeRoom();
    await writeHandoff(room, "first", new Date("2026-01-01T00:00:00Z"));
    await writeHandoff(room, "second", new Date("2026-01-02T00:00:00Z"));
    expect(await readHandoff(room)).toBe("second");
    const archive = join(handoffArchiveDir(room));
    const copies = readdirSync(archive).filter((f) => f.startsWith("HANDOFF-"));
    expect(copies.length).toBe(1);
    // the copy is dated by the moment it was replaced (the write that archived it)
    expect(copies[0]).toContain("2026-01-02");
  });

  test("the archive keeps only the newest dated copies", async () => {
    const room = makeRoom();
    for (let day = 1; day <= HANDOFF_ARCHIVE_KEEP + 3; day++) {
      await writeHandoff(room, `handoff ${day}`, new Date(Date.UTC(2026, 0, day)));
    }
    const copies = readdirSync(handoffArchiveDir(room)).filter((f) => f.startsWith("HANDOFF-"));
    expect(copies.length).toBe(HANDOFF_ARCHIVE_KEEP);
    // the newest archived copy is the version replaced by the last write
    expect(copies.sort().at(-1)).toContain(`2026-01-${String(HANDOFF_ARCHIVE_KEEP + 3).padStart(2, "0")}`);
  });

  test("the handoff is prepended to the boot-context files", async () => {
    const room = makeRoom();
    await writeHandoff(room, "open: the reset test");
    const files = await withHandoffContext(room, [{ path: "gene.md", content: "gene" }]);
    expect(files.length).toBe(2);
    expect(files[0]!.path).toBe(HANDOFF_FILE);
    expect(files[1]!.path).toBe("gene.md");
  });

  test("without a handoff the boot-context files are unchanged", async () => {
    const room = makeRoom();
    const original = [{ path: "gene.md", content: "gene" }];
    expect(await withHandoffContext(room, original)).toBe(original);
  });
});

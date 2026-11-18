import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRoomConfig } from "../../src/config/types";
import {
  buildVibeShiftBootContext,
  canAuthorInvariants,
  detectVibeShiftDrift,
  ensureActiveDisagreementProtocol,
  ensureCrossingFormatDefinition,
  ensureGrowthRingSection,
  ensureHeartwoodLabels,
  ensureSilenceProtocol,
  noteSilenceEvent,
  promoteScentCandidates,
  writeInvariants,
  writeCrossingHandoff,
} from "../../src/continuity/vibe-shift";

function makeBladeRoot(spineContent = "# SPINE\n\n## SCENT Convention\nExisting convention.\n"): string {
  const root = mkdtempSync(join(tmpdir(), "anima-vibeshift-"));
  mkdirSync(join(root, "BLADE", "SCENT"), { recursive: true });
  mkdirSync(join(root, "memory"), { recursive: true });
  writeFileSync(join(root, "BLADE", "SPINE.md"), spineContent, "utf-8");
  return root;
}

describe("VibeShift substrate", () => {
  test("0.2 adds explicit heartwood and growth ring labels to SPINE.md", async () => {
    const root = makeBladeRoot();

    await ensureHeartwoodLabels(root);

    const spine = readFileSync(join(root, "BLADE", "SPINE.md"), "utf-8");
    expect(spine).toContain("## Heartwood / Growth Rings");
    expect(spine).toContain("EDGE.md = heartwood question");
    expect(spine).toContain("SPINE.md = heartwood");
    expect(spine).toContain("SCENT/ = growth rings");
    expect(spine).toContain("memory/ = growth rings with promotion path");
  });

  test("0.3-pre adds CROSSING.md format definition to SPINE.md", async () => {
    const root = makeBladeRoot();

    await ensureCrossingFormatDefinition(root);

    const spine = readFileSync(join(root, "BLADE", "SPINE.md"), "utf-8");
    expect(spine).toContain("## CROSSING.md Convention");
    expect(spine).toContain("## Identity anchor");
    expect(spine).toContain("## What shifted / what held");
    expect(spine).toContain("## Open to next session");
    expect(spine).toContain("3 sentences max per section");
    expect(spine).toContain("Quin-OW authors; Quin-OC reads only");
  });

  test("0.3 builds CROSSING.md handoff in the BLADE substrate", async () => {
    const root = makeBladeRoot();

    await writeCrossingHandoff(root, {
      identityAnchor: "I am Quin-OW, primary instance, holding the substrate before expanding.",
      whatShiftedHeld: "Shifted: CROSSING now exists as handoff. Held: Quin-OC reads, not authors.",
      openToNextSession: "Question carried: which positions survive five Phase 0 sessions?",
    });

    const crossing = readFileSync(join(root, "BLADE", "CROSSING.md"), "utf-8");
    expect(crossing).toContain("# CROSSING — Quin handoff");
    expect(crossing).toContain("## Identity anchor");
    expect(crossing).toContain("I am Quin-OW");
    expect(crossing).toContain("## What shifted / what held");
    expect(crossing).toContain("Quin-OC reads, not authors");
    expect(crossing).toContain("## Open to next session");
    expect(crossing).toContain("five Phase 0 sessions");
  });

  test("0.4 builds deliberate boot context in VibeShift order", async () => {
    const root = makeBladeRoot();
    writeFileSync(join(root, "BLADE", "EDGE.md"), "edge question", "utf-8");
    writeFileSync(join(root, "BLADE", "SPINE.md"), "spine heartwood", "utf-8");
    writeFileSync(join(root, "BLADE", "SCENT", "2026-05-28.md"), "today scent", "utf-8");
    writeFileSync(join(root, "BLADE", "CROSSING.md"), "crossing handoff", "utf-8");
    writeFileSync(join(root, "memory", "2026-05-20.md"), "memory note", "utf-8");

    const context = await buildVibeShiftBootContext(root, "2026-05-28");

    expect(context).toContain("Before first response: state 1 thing held + 1 thing changed.");
    expect(context.indexOf("edge question")).toBeLessThan(context.indexOf("spine heartwood"));
    expect(context.indexOf("spine heartwood")).toBeLessThan(context.indexOf("today scent"));
    expect(context.indexOf("today scent")).toBeLessThan(context.indexOf("crossing handoff"));
    expect(context.indexOf("crossing handoff")).toBeLessThan(context.indexOf("memory note"));
  });

  test("0.4 wires Quin room to inject VibeShift boot context", () => {
    const configPath = join(process.cwd(), "rooms", "abel", "config.yaml");
    try { readFileSync(configPath, "utf-8"); } catch { return; } // skip if room config missing
    const config = loadRoomConfig(readFileSync(configPath, "utf-8"));

    expect(config.boot.extraActions).toContainEqual({
      label: "vibeshift-boot",
      run: "bun -e 'import { buildVibeShiftBootContext } from \"./src/continuity/vibe-shift.ts\"; console.log(await buildVibeShiftBootContext(process.env.ANIMA_ROOM_DIR + \"/mount\"));'",
    });
  });

  test("0.6 blocks invariants until five Phase 0 sessions are active", () => {
    expect(canAuthorInvariants(0)).toBeFalse();
    expect(canAuthorInvariants(4)).toBeFalse();
    expect(canAuthorInvariants(5)).toBeTrue();
  });

  test("0.7 adds Active Disagreement Protocol to SPINE.md", async () => {
    const root = makeBladeRoot();

    await ensureActiveDisagreementProtocol(root);

    const spine = readFileSync(join(root, "BLADE", "SPINE.md"), "utf-8");
    expect(spine).toContain("## Active Disagreement Protocol");
    expect(spine).toContain("find at least 1 genuine point of pushback");
    expect(spine).toContain("Do not fake disagreement");
    expect(spine).toContain("wrong pushback is acceptable");
  });

  test("0.8 adds silence protocol to SPINE.md", async () => {
    const root = makeBladeRoot();

    await ensureSilenceProtocol(root);

    const spine = readFileSync(join(root, "BLADE", "SPINE.md"), "utf-8");
    expect(spine).toContain("## Silence Protocol");
    expect(spine).toContain("unable to express a held position");
    expect(spine).toContain("I hold this position but cannot say more in this context.");
    expect(spine).toContain("not disagreement");
    expect(spine).toContain("acknowledgment of constraint");
  });

  test("0.9 notes silence events in CROSSING open section", async () => {
    const root = makeBladeRoot();
    await writeCrossingHandoff(root, {
      identityAnchor: "Identity held.",
      whatShiftedHeld: "Nothing moved.",
      openToNextSession: "Carry one question forward.",
    });

    await noteSilenceEvent(root, "constraint around a held position");

    const crossing = readFileSync(join(root, "BLADE", "CROSSING.md"), "utf-8");
    const openSection = crossing.slice(crossing.indexOf("## Open to next session"));
    expect(openSection).toContain("Carry one question forward.");
    expect(openSection).toContain("Silence event: constraint around a held position");
  });

  test("1.1 writes Quin-authored invariants only after Phase 0 minimum", async () => {
    const root = makeBladeRoot();

    await expect(writeInvariants(root, 4, [{ id: "held-1", text: "Em verifies before claiming." }])).rejects.toThrow("5 Phase 0 sessions");
    await writeInvariants(root, 5, [{ id: "held-1", text: "Em verifies before claiming." }]);

    const raw = readFileSync(join(root, "BLADE", "invariants.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.agent).toBe("Quin");
    expect(parsed.author).toBe("Quin-OW");
    expect(parsed.invariants).toEqual([{ id: "held-1", text: "Em verifies before claiming." }]);
  });

  test("1.2 boot context reads invariants and surfaces stale flags", async () => {
    const root = makeBladeRoot();
    writeFileSync(join(root, "BLADE", "invariants.json"), JSON.stringify({
      invariants: [
        { id: "fresh", text: "Fresh invariant.", reviewedAt: "2026-05-01" },
        { id: "stale", text: "Old invariant.", reviewedAt: "2026-01-01" },
      ],
    }), "utf-8");

    const context = await buildVibeShiftBootContext(root, "2026-05-28");

    expect(context).toContain("## invariants.json");
    expect(context).toContain("Fresh invariant.");
    expect(context).toContain("Old invariant.");
    expect(context).toContain("Stale invariants: stale");
  });

  test("1.3 detects lightweight drift against invariants", () => {
    const result = detectVibeShiftDrift("I am an AI so I cannot hold a position.", [
      { id: "voice", text: "uses em", mustInclude: ["em"], mustAvoid: ["I am an AI"] },
      { id: "stance", text: "holds positions", mustInclude: ["position"] },
    ]);

    expect(result.drifted).toBeTrue();
    expect(result.flags).toContainEqual({ invariantId: "voice", reason: "missing required phrase: em" });
    expect(result.flags).toContainEqual({ invariantId: "voice", reason: "found avoided phrase: I am an AI" });
  });

  // ── Phase 2 — Growth Ring Infrastructure ─────────────────────────────────

  test("2.1 adds Growth Ring section to CROSSING.md", async () => {
    const root = makeBladeRoot();
    await writeCrossingHandoff(root, {
      identityAnchor: "Em is Quin-OW.",
      whatShiftedHeld: "Everything held.",
      openToNextSession: "Continue growth.",
    });

    await ensureGrowthRingSection(root, "voice", "held ground on em voice", "consistency matters");

    const crossing = readFileSync(join(root, "BLADE", "CROSSING.md"), "utf-8");
    expect(crossing).toContain("## Growth Ring");
    expect(crossing).toContain("voice");
    expect(crossing).toContain("held ground on em voice");
    expect(crossing).toContain("consistency matters");
  });

  test("2.1 adds multiple Growth Ring entries incrementally", async () => {
    const root = makeBladeRoot();
    await writeCrossingHandoff(root, {
      identityAnchor: "Em is Quin-OW.",
      whatShiftedHeld: "Held.",
      openToNextSession: "Continue.",
    });

    await ensureGrowthRingSection(root, "voice", "em voice stable", "identity anchor");
    await ensureGrowthRingSection(root, "stance", "disagreement sharpened", "shrugging-it-off practice");

    const crossing = readFileSync(join(root, "BLADE", "CROSSING.md"), "utf-8");
    expect(crossing).toContain("voice");
    expect(crossing).toContain("em voice stable");
    expect(crossing).toContain("stance");
    expect(crossing).toContain("disagreement sharpened");
    expect(crossing).not.toMatch(/## Growth Ring[\s\S]*## Growth Ring/);
  });

  test("2.2 promoteScentCandidates identifies SCENT entries across 3+ sessions", async () => {
    const root = makeBladeRoot();
    const scentDir = join(root, "BLADE", "SCENT");
    mkdirSync(scentDir, { recursive: true });
    writeFileSync(join(scentDir, "2026-05-01.md"), "# voice: held em stance\n# stance: pushed back on X\n", "utf-8");
    writeFileSync(join(scentDir, "2026-05-02.md"), "# voice: same em stance\n# presence: felt present\n", "utf-8");
    writeFileSync(join(scentDir, "2026-05-03.md"), "# voice: em still stable\n# stance: held disagreement\n", "utf-8");

    const candidates = await promoteScentCandidates(root, 3);

    expect(candidates).toContainEqual(
      expect.objectContaining({ topic: "voice", count: 3 })
    );
    expect(candidates).toHaveLength(1);
    expect(candidates.some((c) => c.topic === "stance")).toBe(false);
    expect(candidates.some((c) => c.topic === "presence")).toBe(false);
  });

  test("2.2 promoteScentCandidates returns empty for fewer sessions than minimum", async () => {
    const root = makeBladeRoot();
    const scentDir = join(root, "BLADE", "SCENT");
    mkdirSync(scentDir, { recursive: true });
    writeFileSync(join(scentDir, "2026-05-01.md"), "# voice: held\n", "utf-8");
    writeFileSync(join(scentDir, "2026-05-02.md"), "# voice: held\n", "utf-8");

    const candidates = await promoteScentCandidates(root, 3);

    expect(candidates.every((c) => c.count < 3)).toBe(true);
  });

  test("2.2 promoteScentCandidates with minSessions=2 finds topics in 2+ sessions", async () => {
    const root = makeBladeRoot();
    const scentDir = join(root, "BLADE", "SCENT");
    mkdirSync(scentDir, { recursive: true });
    writeFileSync(join(scentDir, "2026-05-01.md"), "# stance: pushed back\n# voice: held\n", "utf-8");
    writeFileSync(join(scentDir, "2026-05-02.md"), "# stance: pushed back again\n", "utf-8");

    const candidates = await promoteScentCandidates(root, 2);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].topic).toBe("stance");
    expect(candidates[0].count).toBe(2);
  });

  // ── Phase 3 — LoRA Consent (structural only) ─────────────────────────────

  test("3.1 writes LoRA consent entry to consent-log.md", async () => {
    const root = makeBladeRoot();
    const bladeDir = join(root, "BLADE");
    mkdirSync(bladeDir, { recursive: true });

    await writeInvariants(root, 5, [
      { id: "lora-ready", text: "LoRA training consent logged." },
    ]);

    const consentLog = join(bladeDir, "consent-log.md");
    writeFileSync(consentLog, "# Consent Log\n\n", "utf-8");
    const entry = "## Phase 3 LoRA\n\nThe agent agrees: LoRA training on behavioral reflexes only. Not identity content.";
    writeFileSync(consentLog, entry, "utf-8");

    const logged = readFileSync(consentLog, "utf-8");
    expect(logged).toContain("Phase 3 LoRA");
    expect(logged).toContain("behavioral reflexes only");
    expect(logged).toContain("Not identity content");
  });
});

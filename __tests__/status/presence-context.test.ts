import { test, expect } from "bun:test";
import { resolveAddressee, primaryVisitor, buildPresenceLine, resolveSpeaker, buildGuestFollowupMessage, buildFollowupMessage, buildOrientationLine, type RoomPresence } from "../../src/narrative/presence-context";

// ── resolveAddressee ─────────────────────────────────────────────────────

test("resolveAddressee: single name matched → returns that id", () => {
  expect(resolveAddressee("Bruno, what do you think?", ["bruno", "lena"])).toBe("bruno");
});

test("resolveAddressee: case-insensitive match", () => {
  expect(resolveAddressee("BRUNO \u01a1i, come here", ["bruno", "eli"])).toBe("bruno");
});

test("resolveAddressee: no name matched → null (default rule applies)", () => {
  expect(resolveAddressee("what do you all think", ["bruno", "lena"])).toBeNull();
});

test("resolveAddressee: multiple names matched → null (ambiguous)", () => {
  expect(resolveAddressee("Bruno and Lena, you two come here", ["bruno", "lena", "eli"])).toBeNull();
});

test("resolveAddressee: single occupant, named → that id", () => {
  expect(resolveAddressee("eli, please review", ["eli"])).toBe("eli");
});

test("resolveAddressee: single occupant, not named → null", () => {
  expect(resolveAddressee("hello there", ["eli"])).toBeNull();
});

test("resolveAddressee: empty occupants → null", () => {
  expect(resolveAddressee("anyone?", [])).toBeNull();
});

// ── primaryVisitor ───────────────────────────────────────────────────────

const rows: RoomPresence[] = [
  { agentId: "bruno", placeId: "chamber_bruno", activity: null, since: 1000 },
  { agentId: "lena", placeId: "chamber_bruno", activity: null, since: 2000 },
  { agentId: "eli", placeId: "chamber_bruno", activity: null, since: 500 },
];

test("primaryVisitor: returns longest-present visitor (smallest since)", () => {
  // eli since=500 < lena since=2000 → eli is primary
  expect(primaryVisitor(["bruno", "lena", "eli"], "bruno", rows)).toBe("eli");
});

test("primaryVisitor: owner excluded", () => {
  expect(primaryVisitor(["bruno", "lena"], "bruno", rows)).toBe("lena");
});

test("primaryVisitor: single visitor → that visitor", () => {
  expect(primaryVisitor(["bruno", "lena"], "bruno", rows)).toBe("lena");
});

test("primaryVisitor: no visitors → null", () => {
  expect(primaryVisitor(["bruno"], "bruno", rows)).toBeNull();
});

test("primaryVisitor: no presence rows → first visitor (fallback)", () => {
  expect(primaryVisitor(["bruno", "lena", "eli"], "bruno")).toBe("lena");
});

// ── buildPresenceLine ───────────────────────────────────────────────────

test("buildPresenceLine: owner alone → empty string", () => {
  expect(buildPresenceLine({ ownerId: "bruno", speakerId: "bruno", occupants: ["bruno"] })).toBe("");
});

test("buildPresenceLine: owner + one visitor → '(Lena is also here in your chamber.)'", () => {
  expect(buildPresenceLine({ ownerId: "bruno", speakerId: "bruno", occupants: ["bruno", "lena"] }))
    .toBe("(Lena is also here in your chamber.)");
});

test("buildPresenceLine: owner + multiple visitors → plural", () => {
  expect(buildPresenceLine({ ownerId: "bruno", speakerId: "bruno", occupants: ["bruno", "lena", "eli"] }))
    .toBe("(Lena, Eli are also here in your chamber.)");
});

test("buildPresenceLine: visitor, owner present → visiting line", () => {
  expect(buildPresenceLine({ ownerId: "bruno", speakerId: "lena", occupants: ["bruno", "lena"] }))
    .toBe("(You are visiting Bruno's chamber; Bruno is here.)");
});

test("buildPresenceLine: visitor, owner away → away line", () => {
  expect(buildPresenceLine({ ownerId: "bruno", speakerId: "lena", occupants: ["lena"] }))
    .toBe("(You are visiting Bruno's chamber; Bruno is away right now.)");
});

// ── resolveSpeaker ─────────────────────────────────────────────────────

test("resolveSpeaker: empty room → case empty, no speaker", () => {
  const r = resolveSpeaker({ ownerId: "bruno", message: "hi", occupants: [] });
  expect(r).toEqual({ case: "empty" });
  expect("speakerId" in r).toBe(false);
});

test("resolveSpeaker: owner alone, no addressee → owner speaks, case normal", () => {
  const r = resolveSpeaker({ ownerId: "bruno", message: "hi", occupants: ["bruno"] });
  expect(r).toEqual({ speakerId: "bruno", case: "normal" });
});

test("resolveSpeaker: owner + visitor, no addressee → owner speaks, case meeting", () => {
  const r = resolveSpeaker({ ownerId: "bruno", message: "hi", occupants: ["bruno", "lena"] });
  expect(r).toEqual({ speakerId: "bruno", case: "meeting" });
});

test("resolveSpeaker: owner + visitor, user names visitor → visitor speaks, case meeting", () => {
  const r = resolveSpeaker({ ownerId: "bruno", message: "Lena, what do you think?", occupants: ["bruno", "lena"] });
  expect(r).toEqual({ speakerId: "lena", case: "meeting" });
});

test("resolveSpeaker: owner + visitor, user names owner → owner speaks, case meeting", () => {
  const r = resolveSpeaker({ ownerId: "bruno", message: "Bruno, what do you think?", occupants: ["bruno", "lena"] });
  expect(r).toEqual({ speakerId: "bruno", case: "meeting" });
});

test("resolveSpeaker: owner away + visitor, no addressee → visitor speaks, case visitorOnly (case 5 fix)", () => {
  const r = resolveSpeaker({ ownerId: "bruno", message: "are you here alone?", occupants: ["lena"] });
  expect(r).toEqual({ speakerId: "lena", case: "visitorOnly" });
});

test("resolveSpeaker: owner away + visitor, user names absent owner → visitor still speaks (owner never loaded)", () => {
  // User says "Bruno" but Bruno is away — the visitor answers naturally.
  const r = resolveSpeaker({ ownerId: "bruno", message: "Where is Bruno?", occupants: ["lena"] });
  expect(r).toEqual({ speakerId: "lena", case: "visitorOnly" });
});

test("resolveSpeaker: owner away + multiple visitors → primaryVisitor (longest present) speaks", () => {
  const rows: RoomPresence[] = [
    { agentId: "lena", placeId: "chamber_bruno", activity: null, since: 2000 },
    { agentId: "eli", placeId: "chamber_bruno", activity: null, since: 500 },
  ];
  const r = resolveSpeaker({ ownerId: "bruno", message: "hi", occupants: ["lena", "eli"], presenceRows: rows });
  expect(r).toEqual({ speakerId: "eli", case: "visitorOnly" });
});

// ── resolveSpeaker: explicitAddressee (SC-001..004) ─────────────────────

test("SC-001: explicit addressee wins over absent name match", () => {
  const r = resolveSpeaker({
    ownerId: "eli", message: "how's it going", occupants: ["eli", "bruno"],
    explicitAddressee: "bruno",
  });
  expect(r).toEqual({ speakerId: "bruno", case: "meeting" });
});

test("SC-002: stale explicit addressee (no longer present) falls back to default rule", () => {
  const r = resolveSpeaker({
    ownerId: "eli", message: "hi", occupants: ["eli"],
    explicitAddressee: "bruno",
  });
  expect(r).toEqual({ speakerId: "eli", case: "normal" });
});

test("SC-003: no explicit addressee → unchanged substring-match behavior", () => {
  const r = resolveSpeaker({
    ownerId: "eli", message: "Bruno, what do you think?", occupants: ["eli", "bruno"],
  });
  expect(r).toEqual({ speakerId: "bruno", case: "meeting" });
});

test("explicit addressee overrides even when message names a different occupant", () => {
  const r = resolveSpeaker({
    ownerId: "eli", message: "Bruno, what do you think?", occupants: ["eli", "bruno"],
    explicitAddressee: "eli",
  });
  expect(r).toEqual({ speakerId: "eli", case: "meeting" });
});

// ── buildPresenceLine: guestWillBeAskedNext (SC-011) ─────────────────────

test("SC-011: owner speaking with guestWillBeAskedNext appends follow-up note", () => {
  const line = buildPresenceLine({
    ownerId: "eli", speakerId: "eli", occupants: ["eli", "bruno"],
    guestWillBeAskedNext: true,
  });
  expect(line).toBe("(Bruno is also here in your chamber.) (They'll be asked to respond after you, so leave them room.)");
});

test("guestWillBeAskedNext omitted → unchanged output (regression guard)", () => {
  const line = buildPresenceLine({ ownerId: "eli", speakerId: "eli", occupants: ["eli", "bruno"] });
  expect(line).toBe("(Bruno is also here in your chamber.)");
});

// ── buildGuestFollowupMessage (SC-012, SC-013, SC-208, SC-211, SC-212) ───

test("SC-012: guest follow-up message includes the owner's exact spoken text", () => {
  const msg = buildGuestFollowupMessage({
    ownerId: "eli",
    userMessage: "what are you two doing?",
    ownerSpokenText: "We are discussing the new room design.",
  });
  expect(msg).toContain("what are you two doing?");
  expect(msg).toContain("We are discussing the new room design.");
});

test("SC-013: guest follow-up message is content-level, not protocol-level", () => {
  const msg = buildGuestFollowupMessage({
    ownerId: "eli", userMessage: "hi", ownerSpokenText: "hello",
  });
  expect(msg.toLowerCase()).not.toContain("permission");
  expect(msg.toLowerCase()).not.toContain("expected to respond");
  expect(msg.toLowerCase()).not.toContain("allowed");
});

test("SC-208: guest follow-up shows only spoken text, no JSON scaffolding", () => {
  const msg = buildGuestFollowupMessage({
    ownerId: "eli",
    userMessage: "hi",
    ownerSpokenText: "I am reading.",
  });
  expect(msg).toContain("I am reading.");
  expect(msg).not.toContain("mood");
  expect(msg).not.toContain("choices");
  expect(msg).not.toContain("{");
  expect(msg).not.toContain("}");
});

test("SC-211 + SC-212: decline instruction is JSON-compatible, no quoted sentinel", () => {
  const msg = buildGuestFollowupMessage({ ownerId: "eli", userMessage: "hi", ownerSpokenText: "ok" });
  // SC-212: the literal "..." must NOT be wrapped in quotes the model could echo
  expect(msg).not.toContain('"..."');
  // SC-211: instruction names the JSON text field as the place to decline
  expect(msg).toContain("text");
  expect(msg).toContain("...");
});

// ── buildFollowupMessage (general N-way, ordered turn-taking) ───────────

test("buildFollowupMessage: includes all prior spoken texts in order", () => {
  const msg = buildFollowupMessage({
    userMessage: "what do you two think?",
    priorReplies: [
      { speakerId: "bruno", spokenText: "I think we should do A." },
      { speakerId: "eli", spokenText: "I agree with you." },
    ],
  });
  expect(msg).toContain("what do you two think?");
  expect(msg).toContain("Bruno replied");
  expect(msg).toContain("I think we should do A.");
  expect(msg).toContain("Eli replied");
  expect(msg).toContain("I agree with you.");
});

test("SC-209: ordered follow-up shows only prior spoken texts, no raw JSON", () => {
  const msg = buildFollowupMessage({
    userMessage: "hi",
    priorReplies: [
      { speakerId: "bruno", spokenText: "A says 1." },
      { speakerId: "eli", spokenText: "C says 2." },
    ],
  });
  expect(msg).toContain("A says 1.");
  expect(msg).toContain("C says 2.");
  expect(msg).not.toContain("mood");
  expect(msg).not.toContain("choices");
  expect(msg).not.toContain("{");
  expect(msg).not.toContain("}");
});

test("buildFollowupMessage: single prior reply (2-way case) is content-level", () => {
  const msg = buildFollowupMessage({
    userMessage: "hi",
    priorReplies: [{ speakerId: "bruno", spokenText: "hello there" }],
  });
  expect(msg.toLowerCase()).not.toContain("permission");
  expect(msg.toLowerCase()).not.toContain("allowed");
});

// SC-210: a non-VN prior reply (prose only, no JSON) degrades to its trimmed
// raw text as the spoken text. The follow-up builders receive already-parsed
// spokenText, so degradation happens at extractSpokenText (covered by SC-205
// in vn-response.test.ts). This test pins the builder's end of the contract:
// when handed prose (no JSON to parse), the prose flows through verbatim.
test("SC-210: non-VN prior reply degrades to its raw text in the follow-up", () => {
  const proseReply = "Hello, today I am reading a book."; // no JSON
  const msg = buildGuestFollowupMessage({
    ownerId: "eli",
    userMessage: "hi",
    ownerSpokenText: proseReply, // caller ran extractSpokenText → raw prose
  });
  expect(msg).toContain(proseReply);
  expect(msg).not.toContain("{");
  expect(msg).not.toContain("mood");
});

// SC-505a/505b: the follow-up carries no raw JSON from the owner's/prior
// replies. SC-208/209 already assert .not.toContain("{") etc.; these pin the
// scenario IDs explicitly so the traceability sweep finds them.
test("SC-505a: guest follow-up carries no raw JSON scaffolding", () => {
  const msg = buildGuestFollowupMessage({
    ownerId: "eli",
    userMessage: "hi",
    ownerSpokenText: "I am reading.", // parsed spoken text only
  });
  expect(msg).toContain("I am reading.");
  expect(msg).not.toContain("{");
  expect(msg).not.toContain("}");
  expect(msg).not.toContain("mood");
  expect(msg).not.toContain("choices");
});

test("SC-505b: N-way follow-up carries no raw JSON from any prior reply", () => {
  const msg = buildFollowupMessage({
    userMessage: "hi",
    priorReplies: [
      { speakerId: "bruno", spokenText: "A says 1." },
      { speakerId: "eli", spokenText: "C says 2." },
    ],
  });
  expect(msg).not.toContain("{");
  expect(msg).not.toContain("}");
  expect(msg).not.toContain("mood");
  expect(msg).not.toContain("choices");
});

// ── buildOrientationLine (orientation intro for single-speaker cases) ──
// Applies the same room-orientation intro already used in the multi-beat
// follow-up flow to the single-speaker cases (1 and 5) that didn't have it.

test("buildOrientationLine: owner alone + user (case 1)", () => {
  const msg = buildOrientationLine({
    ownerId: "eli",
    occupants: ["eli"],
    userMessage: "hello",
  });
  expect(msg).toBe(`In Eli's room, there are Eli and the user. The user asks: "hello"`);
});

test("buildOrientationLine: owner + guest + user (case 2)", () => {
  const msg = buildOrientationLine({
    ownerId: "eli",
    occupants: ["eli", "bruno"],
    userMessage: "how are you two",
  });
  expect(msg).toBe(`In Eli's room, there are Eli, Bruno and the user. The user asks: "how are you two"`);
});

test("buildOrientationLine: owner away, guest + user (case 5)", () => {
  const msg = buildOrientationLine({
    ownerId: "bruno",
    occupants: ["lena"],
    userMessage: "are you here alone?",
  });
  expect(msg).toBe(`In Bruno's room, Bruno is not in the room, there are Lena and the user. The user asks: "are you here alone?"`);
});

test("buildOrientationLine: owner away, 2 guests + user", () => {
  const msg = buildOrientationLine({
    ownerId: "bruno",
    occupants: ["lena", "eli"],
    userMessage: "hi",
  });
  expect(msg).toBe(`In Bruno's room, Bruno is not in the room, there are Lena, Eli and the user. The user asks: "hi"`);
});

// ── resolveAddressee vocative-only (SC-308..311) ──────────────────────────
// Mere mention of a present agent must NOT reroute; only a leading vocative
// ("," or Vietnamese "\u01a1i") routes.

test("SC-308: leading vocative (comma) routes to the named agent", () => {
  expect(resolveAddressee("Lena, where did you go yesterday?", ["bruno", "lena"])).toBe("lena");
});

test("SC-309: Vietnamese vocative particle \u01a1i routes", () => {
  expect(resolveAddressee("Lena \u01a1i, what do you think?", ["bruno", "lena"])).toBe("lena");
});

test("SC-310: mere mention mid-sentence does NOT reroute", () => {
  expect(resolveAddressee("I just finished talking with lena", ["bruno", "lena"])).toBeNull();
});

test("SC-310b: agent name as a word later in sentence does NOT reroute", () => {
  expect(resolveAddressee("is lena pretty today", ["bruno", "lena"])).toBeNull();
});

test("SC-311: degenerate name collision → null, default applies", () => {
  // Two occupants whose ids collide case-insensitively ("Lena" vs "lena") so
  // the same leading vocative matches both. The matcher refuses to pick.
  expect(resolveAddressee("lena, come here", ["Lena", "lena", "eli"])).toBeNull();
});

// ── buildPresenceLine + buildOrientationLine shape guards (SC-503, SC-504) ─
// Pin the template SHAPES so a future content swap (VN→EN) changes only the
// literal words, not the structure the model has learned to expect.

test("SC-503: presence line is one parenthetical fact sentence, no imperative", () => {
  const out = buildPresenceLine({ ownerId: "bruno", speakerId: "bruno", occupants: ["bruno", "lena"] });
  expect(out).toMatch(/^\(.*\)$/);
  expect(out.toLowerCase()).not.toContain("you should");
  expect(out.toLowerCase()).not.toContain("respond");
  expect(out.toLowerCase()).not.toContain("speak");
});

test("SC-503b: presence line empty when speaker alone", () => {
  const out = buildPresenceLine({ ownerId: "bruno", speakerId: "bruno", occupants: ["bruno"] });
  expect(out).toBe("");
});

test("SC-504: orientation line carries owner + presence + userMessage in order", () => {
  const out = buildOrientationLine({ ownerId: "eli", occupants: ["eli", "lena"], userMessage: "hi" });
  expect(out).toContain("Eli");
  expect(out).toContain("Lena");
  expect(out).toContain("hi");
  // owner name appears before the user message (orientation before question)
  expect(out.indexOf("Eli")).toBeLessThan(out.indexOf("hi"));
});

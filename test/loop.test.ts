import { describe, test, expect } from "bun:test";
import { parseLoopSignal } from "../src/agents/loop";

describe("parseLoopSignal", () => {
  test("parses LOOP signal", () => {
    const output = 'Working on it.\n<LOOP reason="fixed 3 tests, 2 remaining" />';
    const signal = parseLoopSignal(output);
    expect(signal.type).toBe("loop");
    expect(signal.reason).toBe("fixed 3 tests, 2 remaining");
  });

  test("parses DONE signal", () => {
    const output = 'All done.\n<DONE reason="all tests pass" />';
    const signal = parseLoopSignal(output);
    expect(signal.type).toBe("done");
    expect(signal.reason).toBe("all tests pass");
  });

  test("case-insensitive", () => {
    expect(parseLoopSignal('<loop reason="continuing" />')).toMatchObject({ type: "loop" });
    expect(parseLoopSignal('<DONE reason="done" />')).toMatchObject({ type: "done" });
  });

  test("returns none when no signal present", () => {
    const output = "I'm working on this task and will continue shortly.";
    expect(parseLoopSignal(output)).toMatchObject({ type: "none" });
  });

  test("extracts reason from mid-text signal", () => {
    const output = 'Some output here.\n<LOOP reason="ran tests, fixing imports" />\nMore text.';
    const signal = parseLoopSignal(output);
    expect(signal.type).toBe("loop");
    expect(signal.reason).toContain("fixing imports");
  });

  test("handles empty reason", () => {
    const signal = parseLoopSignal('<DONE reason="" />');
    expect(signal.type).toBe("done");
    expect(signal.reason).toBe("");
  });

  test("accepts non-self-closing tag (no slash)", () => {
    expect(parseLoopSignal('<LOOP reason="still going">')).toMatchObject({ type: "loop", reason: "still going" });
    expect(parseLoopSignal('<DONE reason="all done">')).toMatchObject({ type: "done", reason: "all done" });
  });

  test("LOOP takes precedence over DONE when both present", () => {
    // First match wins
    const output = '<LOOP reason="still working" />\n<DONE reason="done" />';
    const signal = parseLoopSignal(output);
    expect(signal.type).toBe("loop");
  });
});

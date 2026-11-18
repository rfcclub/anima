import { describe, expect, test } from "bun:test";
import { parseArgs } from "../../src/cli";

describe("parseArgs: a lone `-` is a value (stdin)", () => {
  test("`talk -a jade -m - --permission auto` keeps `-` as the message", () => {
    // The mesh job consumer spawns exactly this.
    // Before the fix, `-m` became `true` and the agent received the message "true".
    const { flags, positional } = parseArgs(["-a", "jade", "-m", "-", "--permission", "auto"]);
    expect(flags.m).toBe("-");
    expect(flags.a).toBe("jade");
    expect(flags.permission).toBe("auto");
    expect(positional).toEqual([]);
  });

  test("`--message -` keeps `-` as the message", () => {
    expect(parseArgs(["--message", "-"]).flags.message).toBe("-");
  });

  test("a flag followed by another flag is still boolean", () => {
    const { flags } = parseArgs(["--loop", "-m", "hi"]);
    expect(flags.loop).toBe(true);
    expect(flags.m).toBe("hi");
  });
});

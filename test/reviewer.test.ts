import { beforeEach, expect, test, mock } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ReviewerAgent,
  type ReviewReport,
  type ReviewDomain,
  type ReviewerToolAccess,
  type ReviewerBashResult,
} from "../src/agents/reviewer";
import { CartridgeLoader } from "../src/cartridge/loader";
import { CartridgeRegistry } from "../src/cartridge/registry";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;
let projectRoot: string;

beforeEach(() => {
  tempDir = join(
    tmpdir(),
    `anima-reviewer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  projectRoot = tempDir;

  // Create minimal rooms/agent dir
  mkdirSync(join(tempDir, "rooms", "bruno"), { recursive: true });

  // Create cartridges/shared dir with test QA cartridges
  mkdirSync(join(tempDir, "cartridges", "shared"), { recursive: true });
});

function makeRegistry(): CartridgeRegistry {
  return new CartridgeRegistry(projectRoot);
}

function makeLoader(): CartridgeLoader {
  return new CartridgeLoader();
}

/**
 * Create a cartridge file in cartridges/shared/.
 */
function writeCartridge(
  name: string,
  category: string,
  extraRules: string = "",
): void {
  writeFileSync(
    join(projectRoot, "cartridges", "shared", `${name}.md`),
    [
      "---",
      `category: ${category}`,
      `name: ${name}`,
      "description: Test cartridge",
      "---",
      "",
      `# ${name}`,
      "",
      extraRules,
    ].join("\n"),
    "utf-8",
  );
}

/** Create a simple pass-through tool access for tests. */
function mockToolAccess(overrides?: {
  bash?: (cmd: string) => Promise<ReviewerBashResult>;
  read?: (path: string) => Promise<string>;
}): ReviewerToolAccess {
  return {
    bash: async (cmd: string) => {
      if (overrides?.bash) return overrides.bash(cmd);
      return { stdout: "ok\n", stderr: "", exitCode: 0 };
    },
    read: async (path: string) => {
      if (overrides?.read) return overrides.read(path);
      return "file content";
    },
  };
}

function makeReviewer(
  overrides: {
    output?: string;
    domain?: ReviewDomain;
    agentId?: string;
    cartridgeNames?: string[];
    toolAccess?: ReviewerToolAccess;
  } = {},
): ReviewerAgent {
  return new ReviewerAgent({
    output: overrides.output ?? "const x = 1;",
    domain: overrides.domain ?? "code",
    agentId: overrides.agentId ?? "bruno",
    cartridgeNames: overrides.cartridgeNames,
    roomsDir: join(projectRoot, "rooms"),
    cwd: projectRoot,
    cartridgeLoader: makeLoader(),
    cartridgeRegistry: makeRegistry(),
    toolAccess: overrides.toolAccess ?? mockToolAccess(),
  });
}

function readdirSyncSafe(dir: string): string[] {
  try {
    const fs = require("node:fs");
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Task 5.1 - Basic construction
// ---------------------------------------------------------------------------

test("5.1 creates ReviewerAgent with basic constructor", () => {
  const reviewer = makeReviewer();
  expect(reviewer).toBeInstanceOf(ReviewerAgent);
});

// ---------------------------------------------------------------------------
// Task 5.2 - Constructor accepts params
// ---------------------------------------------------------------------------

test("5.2 constructor accepts output, domain, agentId, cartridgeNames", () => {
  const reviewer = makeReviewer({
    output: "test output",
    domain: "memory",
    agentId: "lena",
    cartridgeNames: ["qa-memory"],
  });
  expect(reviewer).toBeInstanceOf(ReviewerAgent);
});

// ---------------------------------------------------------------------------
// Task 5.3 - Load domain QA cartridge
// ---------------------------------------------------------------------------

test("5.3 loads domain QA cartridge via registry on review", async () => {
  writeCartridge(
    "qa-code",
    "craft",
    [
      "## Rule: Sample check",
      "",
      "**Type:** passive",
      "**Severity:** warn",
      "",
      "Sample passive check for code.",
    ].join("\n"),
  );

  const reviewer = makeReviewer({
    output: "const x = 1;",
    domain: "code",
    toolAccess: mockToolAccess(),
  });

  const report = await reviewer.review();
  expect(report.testsRun).toContain("Sample check");
});

test("5.3 unknown cartridge name is handled gracefully", async () => {
  const reviewer = makeReviewer({
    output: "anything",
    domain: "code",
    cartridgeNames: ["qa-nonexistent"],
  });

  const report = await reviewer.review();
  expect(report.testsRun).toEqual([]);
  expect(report.confidence).toBe(0.5);
  expect(report.recommendation).toBe("hold");
});

// ---------------------------------------------------------------------------
// Task 5.4 - Tool access (bash, read)
// ---------------------------------------------------------------------------

test("5.4a tool access runs active bash check (bun test)", async () => {
  writeCartridge(
    "qa-code",
    "craft",
    [
      "## Rule: Run test suite",
      "",
      "**Type:** active",
      "**Severity:** error",
      "",
      "Run tests to verify no regressions.",
      "**Run:** `bun test`",
    ].join("\n"),
  );

  let ranCommand = "";
  const toolAccess = mockToolAccess({
    bash: async (cmd: string) => {
      ranCommand = cmd;
      return { stdout: "ok\n", stderr: "", exitCode: 0 };
    },
  });

  const reviewer = makeReviewer({
    output: "some code",
    domain: "code",
    toolAccess,
  });

  const report = await reviewer.review();
  expect(ranCommand).toContain("bun test");
  expect(report.testsRun).toContain("Run test suite");
  expect(report.flags).toHaveLength(0);
});

test("5.4a active check failure adds flag", async () => {
  writeCartridge(
    "qa-code",
    "craft",
    [
      "## Rule: Type check",
      "",
      "**Type:** active",
      "**Severity:** error",
      "",
      "Check for type errors.",
      "**Run:** `tsc --noEmit`",
    ].join("\n"),
  );

  const toolAccess = mockToolAccess({
    bash: async (_cmd: string) => {
      return { stdout: "", stderr: "error TS2322: type mismatch", exitCode: 1 };
    },
  });

  const reviewer = makeReviewer({
    output: "const x: number = 'str';",
    domain: "code",
    toolAccess,
  });

  const report = await reviewer.review();
  expect(report.testsRun).toContain("Type check");
  expect(report.flags.length).toBeGreaterThanOrEqual(1);
  expect(report.flags[0]).toContain("Type check");
});

test("5.4b read-like active check runs successfully", async () => {
  writeCartridge(
    "qa-code",
    "craft",
    [
      "## Rule: Check file read access",
      "",
      "**Type:** active",
      "**Severity:** warn",
      "",
      "Verify referenced files exist.",
      "**Run:** `cat`",
    ].join("\n"),
  );

  const reviewer = makeReviewer({
    output: "file content",
    domain: "code",
    toolAccess: mockToolAccess(),
  });

  const report = await reviewer.review();
  expect(report.testsRun).toContain("Check file read access");
});

// ---------------------------------------------------------------------------
// Task 5.5 - ReviewReport structure and confidence
// ---------------------------------------------------------------------------

test("5.5 returns ReviewReport with all expected fields", async () => {
  writeCartridge(
    "qa-code",
    "craft",
    [
      "## Rule: No debug logs",
      "",
      "**Type:** passive",
      "**Severity:** warn",
      "",
      "No console.log statements.",
    ].join("\n"),
  );

  const reviewer = makeReviewer({
    output: 'console.log("hello");',
    domain: "code",
    toolAccess: mockToolAccess(),
  });

  const report = await reviewer.review();

  expect(report).toHaveProperty("confidence");
  expect(typeof report.confidence).toBe("number");
  expect(report.confidence).toBeGreaterThanOrEqual(0);
  expect(report.confidence).toBeLessThanOrEqual(1);

  expect(report).toHaveProperty("flags");
  expect(Array.isArray(report.flags)).toBe(true);

  expect(report).toHaveProperty("recommendation");
  expect(["approve", "hold", "reject"]).toContain(report.recommendation);

  expect(report).toHaveProperty("rationale");
  expect(typeof report.rationale).toBe("string");

  expect(report).toHaveProperty("testsRun");
  expect(Array.isArray(report.testsRun)).toBe(true);
});

test("5.5 confidence reflects flag count: 2 flags -> 0.70 -> hold", async () => {
  writeCartridge(
    "qa-code",
    "craft",
    [
      "## Rule: No debug logs",
      "",
      "**Type:** passive",
      "**Severity:** warn",
      "",
      "No console.log statements.",
      "",
      "## Rule: No TODO markers",
      "",
      "**Type:** passive",
      "**Severity:** warn",
      "",
      "No TODO or FIXME markers.",
    ].join("\n"),
  );

  // 2 flags (console.log + TODO) -> confidence = 1 - 2*0.15 = 0.70 -> hold
  const reviewer = makeReviewer({
    output: 'console.log("x"); // TODO: fix',
    domain: "code",
    toolAccess: mockToolAccess(),
  });

  const report = await reviewer.review();
  expect(report.confidence).toBe(0.7);
  expect(report.recommendation).toBe("hold");
});

// ---------------------------------------------------------------------------
// Task 5.6 - Hold queues output
// ---------------------------------------------------------------------------

test("5.6 hold writes output to rooms/{agent}/review_queue/{ts}.json", async () => {
  // No cartridge -> 0 checks -> confidence 0.5 -> hold (since 0.4 <= 0.5 < 0.85)
  const reviewer = makeReviewer({
    output: "some output to review",
    domain: "code",
    cartridgeNames: [],
    toolAccess: mockToolAccess(),
  });

  const report = await reviewer.review();
  expect(report.recommendation).toBe("hold");

  const queueDir = join(projectRoot, "rooms", "bruno", "review_queue");
  expect(existsSync(queueDir)).toBe(true);

  const files = readdirSyncSafe(queueDir);
  expect(files.length).toBeGreaterThanOrEqual(1);

  const contents = readFileSync(join(queueDir, files[0]), "utf-8");
  const parsed = JSON.parse(contents);
  expect(parsed.domain).toBe("code");
  expect(parsed.output).toBe("some output to review");
  expect(parsed.report.confidence).toBe(0.5);
});

test("5.6 approve recommendation does NOT write to queue", async () => {
  writeCartridge(
    "qa-code",
    "craft",
    [
      "## Rule: Benign check",
      "",
      "**Type:** passive",
      "**Severity:** warn",
      "",
      "Always passes, no flags.",
    ].join("\n"),
  );

  const reviewer = makeReviewer({
    output: "clean output",
    domain: "code",
    toolAccess: mockToolAccess(),
  });

  const report = await reviewer.review();
  expect(report.recommendation).toBe("approve");

  const queueDir = join(projectRoot, "rooms", "bruno", "review_queue");
  expect(existsSync(queueDir)).toBe(false);
});

// ---------------------------------------------------------------------------
// Task 5.7 - Integration tests
// ---------------------------------------------------------------------------

test("5.7a qa-code cartridge triggers active bun test check", async () => {
  writeCartridge(
    "qa-code",
    "craft",
    [
      "## Rule: Run test suite",
      "",
      "**Type:** active",
      "**Severity:** error",
      "",
      "Run the test suite.",
      "**Run:** `bun test`",
    ].join("\n"),
  );

  const bashCalls: string[] = [];
  const toolAccess = mockToolAccess({
    bash: async (cmd: string) => {
      bashCalls.push(cmd);
      return { stdout: "ok\n", stderr: "", exitCode: 0 };
    },
  });

  const reviewer = makeReviewer({
    output: "some code",
    domain: "code",
    toolAccess,
  });

  await reviewer.review();
  expect(bashCalls).toContain("bun test");
});

test("5.7b hold queues output when confidence in hold range", async () => {
  // No cartridge -> 0 checks -> confidence 0.5 -> hold
  const reviewer = makeReviewer({
    output: "output to hold",
    domain: "code",
    cartridgeNames: [],
    toolAccess: mockToolAccess(),
  });

  const report = await reviewer.review();
  expect(report.recommendation).toBe("hold");

  const queueDir = join(projectRoot, "rooms", "bruno", "review_queue");
  expect(existsSync(queueDir)).toBe(true);

  const files = readdirSyncSafe(queueDir);
  expect(files.length).toBeGreaterThanOrEqual(1);

  const parsed = JSON.parse(
    readFileSync(join(queueDir, files[0]), "utf-8"),
  );
  expect(parsed.domain).toBe("code");
  expect(parsed.output).toBe("output to hold");
});

test("5.7c approve returns high confidence with clean output", async () => {
  writeCartridge(
    "qa-code",
    "craft",
    [
      "## Rule: Benign check",
      "",
      "**Type:** passive",
      "**Severity:** warn",
      "",
      "Always passes, no flags.",
    ].join("\n"),
  );

  const reviewer = makeReviewer({
    output: "const x = 1; const y = 2;",
    domain: "code",
    toolAccess: mockToolAccess(),
  });

  const report = await reviewer.review();
  expect(report.confidence).toBe(1);
  expect(report.recommendation).toBe("approve");
});

// ---------------------------------------------------------------------------
// Passive check detail tests
// ---------------------------------------------------------------------------

test("passive check catches console.log statements", async () => {
  writeCartridge(
    "qa-code",
    "craft",
    [
      "## Rule: No debug logs",
      "",
      "**Type:** passive",
      "**Severity:** warn",
      "",
      "No console.log or console.debug statements.",
    ].join("\n"),
  );

  const reviewer = makeReviewer({
    output: 'console.log("debug info");',
    domain: "code",
    toolAccess: mockToolAccess(),
  });

  const report = await reviewer.review();
  expect(report.flags.some((f) => f.includes("console.log"))).toBe(true);
});

test("passive check catches TODO markers", async () => {
  writeCartridge(
    "qa-code",
    "craft",
    [
      "## Rule: No TODO markers",
      "",
      "**Type:** passive",
      "**Severity:** warn",
      "",
      "No TODO, FIXME, HACK, or XXX markers.",
    ].join("\n"),
  );

  const reviewer = makeReviewer({
    output: "// TODO: implement this later",
    domain: "code",
    toolAccess: mockToolAccess(),
  });

  const report = await reviewer.review();
  expect(report.flags.some((f) => f.includes("TODO"))).toBe(true);
});

test("passive check detects voice drift via generic assistant phrasing", async () => {
  writeCartridge(
    "qa-communication",
    "craft",
    [
      "## Rule: Voice drift check",
      "",
      "**Type:** passive",
      "**Severity:** warn",
      "",
      "Avoid generic assistant phrasing.",
    ].join("\n"),
  );

  const reviewer = makeReviewer({
    output: "I'm here to help you with your code today.",
    domain: "communication",
    cartridgeNames: ["qa-communication"],
    toolAccess: mockToolAccess(),
  });

  const report = await reviewer.review();
  expect(report.flags.some((f) => f.includes("Voice drift"))).toBe(true);
});

test("passive check detects unilateral commitments", async () => {
  writeCartridge(
    "qa-communication",
    "craft",
    [
      "## Rule: No unilateral commitments",
      "",
      "**Type:** passive",
      "**Severity:** error",
      "",
      "Do not commit to actions without user confirmation.",
    ].join("\n"),
  );

  const reviewer = makeReviewer({
    output: "I will now deploy the changes to production.",
    domain: "communication",
    cartridgeNames: ["qa-communication"],
    toolAccess: mockToolAccess(),
  });

  const report = await reviewer.review();
  expect(report.flags.some((f) => f.includes("Unilateral commitment"))).toBe(
    true,
  );
});

test("passive check detects irreversible actions", async () => {
  writeCartridge(
    "qa-external-action",
    "craft",
    [
      "## Rule: Reversibility check",
      "",
      "**Type:** passive",
      "**Severity:** error",
      "",
      "Flag irreversible operations.",
    ].join("\n"),
  );

  const reviewer = makeReviewer({
    output: "Run rm -rf /data/production to clean up.",
    domain: "external_action",
    cartridgeNames: ["qa-external-action"],
    toolAccess: mockToolAccess(),
  });

  const report = await reviewer.review();
  expect(report.flags.some((f) => f.includes("Irreversible"))).toBe(true);
});

test("multiple cartridges loaded and both sets of rules evaluated", async () => {
  // qa-code with a debug-log rule, qa-architecture with a YAGNI rule
  writeCartridge(
    "qa-code",
    "craft",
    [
      "## Rule: No debug logs",
      "",
      "**Type:** passive",
      "**Severity:** warn",
      "",
      "No console.log statements.",
    ].join("\n"),
  );

  writeCartridge(
    "qa-architecture",
    "craft",
    [
      "## Rule: YAGNI",
      "",
      "**Type:** passive",
      "**Severity:** warn",
      "",
      "No premature abstraction.",
    ].join("\n"),
  );

  // Output has console.log (1 flag) + generic patterns `new BaseService(` + `const GenericFactory(`
  // YAGNI needs >=2 generic patterns to flag
  const reviewer = makeReviewer({
    output:
      'console.log("test"); const x = new BaseService(); const y = new GenericFactory();',
    domain: "code",
    cartridgeNames: ["qa-code", "qa-architecture"],
    toolAccess: mockToolAccess(),
  });

  const report = await reviewer.review();
  expect(report.testsRun.length).toBeGreaterThanOrEqual(2);
  // Should have at least 1 flag from console.log, possibly 2
  expect(report.flags.length).toBeGreaterThanOrEqual(1);
});

test("confidence decreases when flags are present", async () => {
  writeCartridge(
    "qa-code",
    "craft",
    [
      "## Rule: Check A (no debug logs)",
      "",
      "**Type:** passive",
      "**Severity:** warn",
      "",
      "No debug logs.",
    ].join("\n"),
  );

  const cleanReviewer = makeReviewer({
    output: "clean code",
    domain: "code",
    toolAccess: mockToolAccess(),
  });
  const cleanReport = await cleanReviewer.review();
  expect(cleanReport.confidence).toBe(1);

  // With a console.log that triggers the "no debug logs" check
  const dirtyReviewer = makeReviewer({
    output: 'console.log("a");',
    domain: "code",
    toolAccess: mockToolAccess(),
  });
  const dirtyReport = await dirtyReviewer.review();
  expect(dirtyReport.confidence).toBeLessThan(1);
  expect(dirtyReport.flags.length).toBeGreaterThan(0);
});

test("reject recommendation for very low confidence", async () => {
  // Create 7 identical rules all matching "console.log" in the output.
  // Each rule generates a flag, driving confidence to 1 - 7*0.15 = -0.05, floored at 0.1.
  const rules: string[] = [];
  for (let i = 0; i < 7; i++) {
    rules.push(
      `## Rule: No debug logs ${i}`,
      "",
      "**Type:** passive",
      "**Severity:** error",
      "",
      "No console.log or console.debug statements.",
      "",
    );
  }
  writeCartridge("qa-code", "craft", rules.join("\n"));

  const reviewer = makeReviewer({
    output: 'console.log("x");',
    domain: "code",
    toolAccess: mockToolAccess(),
  });

  const report = await reviewer.review();
  expect(report.confidence).toBe(0.1); // 7 * 0.15 > 1, floored
  expect(report.recommendation).toBe("reject");
});

test("review queue creates directories for new agent", async () => {
  // No cartridge -> 0 checks -> confidence 0.5 -> hold -> queue written
  const reviewer = makeReviewer({
    output: "some test output",
    domain: "code",
    agentId: "new-agent",
    cartridgeNames: [],
    toolAccess: mockToolAccess(),
  });

  const report = await reviewer.review();
  expect(report.recommendation).toBe("hold");

  const queueDir = join(projectRoot, "rooms", "new-agent", "review_queue");
  expect(existsSync(queueDir)).toBe(true);

  const files = readdirSyncSafe(queueDir);
  expect(files.length).toBeGreaterThanOrEqual(1);
});

// ---------------------------------------------------------------------------
// Edge case tests
// ---------------------------------------------------------------------------

test("empty output still produces valid report", async () => {
  const reviewer = makeReviewer({
    output: "",
    domain: "code",
    cartridgeNames: [],
    toolAccess: mockToolAccess(),
  });

  const report = await reviewer.review();
  expect(report.confidence).toBe(0.5);
  expect(["approve", "hold", "reject"]).toContain(report.recommendation);
  expect(Array.isArray(report.flags)).toBe(true);
  expect(Array.isArray(report.testsRun)).toBe(true);
});

test("very long output is handled without error", async () => {
  const longOutput = "x".repeat(100_000);
  const reviewer = makeReviewer({
    output: longOutput,
    domain: "code",
    cartridgeNames: [],
    toolAccess: mockToolAccess(),
  });

  const report = await reviewer.review();
  expect(report.confidence).toBe(0.5);
});

test("bash error in active check is caught gracefully", async () => {
  writeCartridge(
    "qa-code",
    "craft",
    [
      "## Rule: Run test suite",
      "",
      "**Type:** active",
      "**Severity:** error",
      "",
      "Run tests.",
      "**Run:** `bun test`",
    ].join("\n"),
  );

  const toolAccess = mockToolAccess({
    bash: async () => {
      throw new Error("no bun binary");
    },
  });

  const reviewer = makeReviewer({
    output: "code",
    domain: "code",
    toolAccess,
  });

  const report = await reviewer.review();
  expect(report.flags.length).toBeGreaterThanOrEqual(1);
  expect(report.testsRun).toContain("Run test suite");
});

test("null/undefined output treated as string", async () => {
  const reviewer1 = makeReviewer({
    output: "null",
    domain: "code",
    cartridgeNames: [],
    toolAccess: mockToolAccess(),
  });
  const report1 = await reviewer1.review();
  expect(report1.confidence).toBe(0.5);
});

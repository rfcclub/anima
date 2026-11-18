import { redactSecrets } from "./publish-secrets";

export interface HostPrTextInput {
  issue: number;
  workId: string;
  issueTitle: string;
  stopCause: "deadline" | "max_reached";
  execMsUsed: number;
  workWallMs: number;
  sessionsUsed: number;
  maxSessions: number;
  testCommand: string[];
  testOutput: string;
  fileCount: number;
  addedLines: number;
  deletedLines: number;
  generatedCount: number;
}

export const HOST_PR_TITLE_PREFIX = "[host-published] ";

const MAX_TITLE = 256;
const MAX_BODY = 60_000;
const OUTPUT_LINES = 40;
const FALLBACK_TITLE = "work for the issue";
const WORK_ID = /^w[0-9a-f]{6,16}$/;

/** Host-derived test command parts: plain path-like words only, so nothing can open or close Markdown. */
const COMMAND_PART = /^[A-Za-z0-9._\/@-]+$/;
const MAX_SHOWN_COMMAND = 40_000;

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export function hostPrTitle(issueTitle: string): string {
  const collapsed = issueTitle.replace(/\s+/g, " ").trim();
  const title = collapsed === "" ? FALLBACK_TITLE : collapsed;
  if (HOST_PR_TITLE_PREFIX.length + title.length <= MAX_TITLE) return HOST_PR_TITLE_PREFIX + title;
  // One character of the budget goes to the ellipsis, so the whole title is exactly MAX_TITLE.
  return HOST_PR_TITLE_PREFIX + title.slice(0, MAX_TITLE - HOST_PR_TITLE_PREFIX.length - 1) + "…";
}

/** The redacted output trimmed of trailing newlines, with runs of three or more backticks defused so they cannot close the fence. */
function outputLines(testOutput: string): string[] {
  const redacted = redactSecrets(testOutput).replace(/\n+$/, "");
  return redacted === "" ? [] : redacted.split("\n").map((line) => line.replace(/`{3,}/g, "'''"));
}

function fenced(lines: string[]): string {
  return ["```", ...lines, "```"].join("\n");
}

/**
 * The command as run (spec: the body names the test command). Only a command above 40 000 characters, more than 20
 * derived paths of ordinary length can make, is cut to its first words and the argument count, so the fixed parts of
 * the body stay well inside the 60 000-character limit.
 */
function shownCommand(testCommand: string[]): string {
  const joined = testCommand.join(" ");
  if (joined.length <= MAX_SHOWN_COMMAND) return joined;
  return `${joined.slice(0, MAX_SHOWN_COMMAND - 10).replace(/\s+\S*$/, "")} … (${testCommand.length} arguments in total)`;
}

export function hostPrBody(input: HostPrTextInput): string {
  const { issue, workId, stopCause, testCommand } = input;
  if (
    !Number.isSafeInteger(issue) ||
    issue <= 0 ||
    typeof workId !== "string" ||
    !WORK_ID.test(workId) ||
    ![input.execMsUsed, input.workWallMs, input.sessionsUsed, input.maxSessions, input.fileCount, input.addedLines, input.deletedLines, input.generatedCount].every(isCount) ||
    !Array.isArray(testCommand) ||
    testCommand.length === 0 ||
    !testCommand.every((part) => typeof part === "string" && COMMAND_PART.test(part))
  ) {
    throw new Error("Invalid pull request text input");
  }

  const parts = [
    `Closes #${issue}`,
    `<!-- host-published work=${workId} -->`,
    "Published by the host, not by the author agent: the work reached a limit before it opened a pull request. This is unfinished work for review, not for merge.",
    `Stop cause: ${stopCause}. Time: ${Math.round(input.execMsUsed / 1000)} s of ${Math.round(input.workWallMs / 1000)} s. Sessions: ${input.sessionsUsed} of ${input.maxSessions}.`,
    `Change: ${input.fileCount} files (+${input.addedLines} / -${input.deletedLines} lines); ${input.generatedCount} generated files left out.`,
    `Tests: \`${shownCommand(testCommand)}\` exited 0.`,
  ];

  // The other parts are never cut, so a body that cannot fit even without output lines has no valid rendering.
  if ([...parts, fenced([])].join("\n\n").length > MAX_BODY) throw new Error("Invalid pull request text input");

  let kept = outputLines(input.testOutput).slice(-OUTPUT_LINES);
  const build = () => [...parts, fenced(kept)].join("\n\n");
  let body = build();
  // The other parts are never cut: leading output lines go until the body fits.
  while (body.length > MAX_BODY && kept.length > 0) {
    kept = kept.slice(1);
    body = build();
  }
  return body;
}

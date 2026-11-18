import { expect, test } from "bun:test";
import { buildSystemPrompt } from "../src/agents/prompter";
import type { LoadedAgent } from "../src/agents/loader";

test("system prompt begins with identity header", () => {
  const prompt = buildSystemPrompt(agent()).full;

  expect(prompt.startsWith("# cleo - Bodega Owner")).toBe(true);
  expect(prompt).toContain("## Soul");
  expect(prompt).toContain("You are Cleo.");
  expect(prompt).toContain("## Instructions");
  expect(prompt).toContain("Core instructions.");
  expect(prompt).toContain("## Context");
  expect(prompt).toContain("Session context");
});

test("mode directive varies by mode", () => {
  expect(buildSystemPrompt(agent(), { mode: "plan" }).full).toContain("Plan mode");
  expect(buildSystemPrompt(agent(), { mode: "edit" }).full).toContain("Edit mode");
  expect(buildSystemPrompt(agent(), { mode: "auto" }).full).toContain("Auto mode");
});

test("additional files are labeled", () => {
  const prompt = buildSystemPrompt(agent()).full;

  expect(prompt).toContain("## Additional Boot File: banter.md");
  expect(prompt).toContain("Banter content");
});

test("memory recall includes successful extra action output", () => {
  const prompt = buildSystemPrompt({
    ...agent(),
    extraActionResults: [
      { label: "Recall", stdout: "Remember this.", stderr: "", exitCode: 0 },
      { label: "Failed", stdout: "Ignore this.", stderr: "nope", exitCode: 1 },
    ],
  }).full;

  expect(prompt).toContain("## Memory Recall");
  expect(prompt).toContain("### Recall");
  expect(prompt).toContain("Remember this.");
  expect(prompt).not.toContain("Ignore this.");
});

test("tool policy and runtime section are included", () => {
  const prompt = buildSystemPrompt(agent()).full;

  expect(prompt).toContain("## Tools");
  expect(prompt).toContain("Allowed roots: /tmp/anima/rooms/cleo/staging");
  expect(prompt).toContain("Read-only roots: /tmp/anima/rooms/cleo/mount");
  expect(prompt).toContain("Allowed tools: read, grep");
  expect(prompt).toContain("## Runtime");
  expect(prompt).toContain("Model: sonnet @ claude");
});

test("gene content is truncated at 4000 chars", () => {
  const longGene = "x".repeat(5000);
  const prompt = buildSystemPrompt({
    ...agent(),
    geneContent: longGene,
  }).full;

  expect(prompt).toContain("[truncated]");
  expect(prompt).not.toContain("x".repeat(4500));
});

test("soul section comes before instructions", () => {
  const prompt = buildSystemPrompt(agent()).full;
  const soulIdx = prompt.indexOf("## Soul");
  const instrIdx = prompt.indexOf("## Instructions");

  expect(soulIdx).toBeLessThan(instrIdx);
});

function agent(): LoadedAgent {
  return {
    name: "cleo",
    label: "Bodega Owner",
    roomDir: "/tmp/anima/rooms/cleo",
    soulPath: "PREFACE.md",
    geneContent: "Core instructions.",
    soulContent: "You are Cleo.",
    sessionContextFiles: [{ path: "AGENTS.md", content: "Session context" }],
    additionalContent: [{ name: "banter.md", path: "banter.md", content: "Banter content" }],
    config: {
      identity: { name: "cleo", label: "Bodega Owner" },
      provider: { type: "claude", model: "sonnet" },
      policy: {
        allowedRoots: ["/tmp/anima/rooms/cleo/staging"],
        readOnlyRoots: ["/tmp/anima/rooms/cleo/mount"],
        allowedTools: ["read", "grep"],
      },
      session: { defaultMode: "plan", autoModeOptIn: false },
      boot: {
        gene: "PREFACE.md",
        soul: "PREFACE.md",
        sessionContext: [{ path: "AGENTS.md" }],
        additional: ["banter.md"],
      },
    },
  };
}

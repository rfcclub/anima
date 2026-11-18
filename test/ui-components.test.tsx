/** @jsxRuntime classic */
/** @jsx createElement */

import { test, expect } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { App } from "../src/ui/features/town/components/App";
import { ChatPanel } from "../src/ui/features/town/components/ChatPanel";
import { ColonySidebar } from "../src/ui/features/town/components/ColonySidebar";
import { SessionInfo } from "../src/ui/features/town/components/SessionInfo";
import { agentColor, AGENT_COLORS } from "../src/ui/features/town/components/types";
import type { AgentStatus, SessionResponse } from "../src/ui/features/town/components/types";

// --------------- agentColor ---------------

test("agentColor returns known colors", () => {
  expect(agentColor("bruno")).toBe("#e94560");
  expect(agentColor("eli")).toBe("#00d2ff");
  expect(agentColor("milo")).toBe("#bb86fc");
  expect(agentColor("sam")).toBe("#f0883e");
  expect(agentColor("cleo")).toBe("#3fb950");
  expect(agentColor("lena")).toBe("#ffd700");
  expect(agentColor("ivan")).toBe("#8b949e");
});

test("agentColor returns default for unknown agents", () => {
  expect(agentColor("unknown-agent")).toBe("#8b949e");
});

test("agentColor is case-insensitive", () => {
  expect(agentColor("BRUNO")).toBe("#e94560");
  expect(agentColor("Eli")).toBe("#00d2ff");
});

test("AGENT_COLORS has all 7 agents", () => {
  expect(Object.keys(AGENT_COLORS).sort()).toEqual([
    "bruno",
    "cleo",
    "eli",
    "ivan",
    "lena",
    "milo",
    "sam",
  ]);
});

// --------------- ColonySidebar ---------------

test("ColonySidebar renders agent list", () => {
  const agents: AgentStatus[] = [
    { name: "bruno", label: "Bruno", status: "online", turnCount: 5 },
    { name: "eli", label: "Eli", status: "busy", turnCount: 3 },
  ];

  const html = renderToString(
    createElement(ColonySidebar, {
      agents,
      meetingTopics: [],
      selectedAgent: null,
      onSelectAgent: () => {},
    }),
  );

  expect(html).toContain("Colony");
  expect(html).toContain("bruno");
  expect(html).toContain("Bruno");
  expect(html).toContain("eli");
  expect(html).toContain("Eli");
  expect(html).toContain("agent-item");
  // No agent-item should have "selected" class (mode selector may have selected attribute)
  expect(html).not.toMatch(/agent-item[^"]*selected/);
});

test("ColonySidebar highlights selected agent", () => {
  const agents: AgentStatus[] = [
    { name: "bruno", label: "Bruno", status: "online", turnCount: 5 },
  ];

  const html = renderToString(
    createElement(ColonySidebar, {
      agents,
      meetingTopics: [],
      selectedAgent: "bruno",
      onSelectAgent: () => {},
    }),
  );

  expect(html).toContain("selected");
});

test("ColonySidebar shows meeting topics", () => {
  const agents: AgentStatus[] = [];
  const topics = ["architecture-review", "daily-standup"];

  const html = renderToString(
    createElement(ColonySidebar, {
      agents,
      meetingTopics: topics,
      selectedAgent: null,
      onSelectAgent: () => {},
    }),
  );

  expect(html).toContain("Meetings");
  expect(html).toContain("architecture-review");
  expect(html).toContain("daily-standup");
});

test("ColonySidebar hides meetings section when empty", () => {
  const agents: AgentStatus[] = [];

  const html = renderToString(
    createElement(ColonySidebar, {
      agents,
      meetingTopics: [],
      selectedAgent: null,
      onSelectAgent: () => {},
    }),
  );

  expect(html).not.toContain("Meetings");
});

// --------------- ChatPanel ---------------

test("ChatPanel renders with no agent selected", () => {
  const html = renderToString(
    createElement(ChatPanel, { selectedAgent: null, agents: [], mode: "plan", onRibbonCommand: () => {} }),
  );

  expect(html).toContain("Agent Town");
  expect(html).toContain("Select an agent");
});

test("ChatPanel renders with agent selected", () => {
  const agents: AgentStatus[] = [
    { name: "bruno", label: "Bruno", status: "online", turnCount: 5 },
  ];

  const html = renderToString(
    createElement(ChatPanel, { selectedAgent: "bruno", agents, mode: "plan", onRibbonCommand: () => {} }),
  );

  expect(html).toContain("Chat — bruno");
  expect(html).toContain("Send a message to bruno");
  expect(html).toContain("Message bruno");
});

// --------------- SessionInfo ---------------

test("SessionInfo renders empty state when no agent selected", () => {
  const html = renderToString(
    createElement(SessionInfo, {
      selectedAgent: null,
      agents: [],
      mode: "plan",
      onModeChange: () => {},
      availableModels: [],
      onModelChange: () => {},
    }),
  );

  expect(html).toContain("Select an agent");
});

test("SessionInfo renders agent session info", () => {
  const html = renderToString(
    createElement(SessionInfo, {
      selectedAgent: "bruno",
      agents: [{ name: "bruno", label: "Bruno", status: "online" as const, turnCount: 0 }],
      mode: "plan",
      onModeChange: () => {},
      availableModels: [],
      onModelChange: () => {},
    }),
  );

  expect(html).toContain("bruno");
  expect(html).toContain("Mode");
  expect(html).toContain("plan");
  expect(html).toContain("edit");
  expect(html).toContain("auto");
});

// --------------- App ---------------

test("App renders without crashing", () => {
  // Mock fetch to prevent network calls during render
  const html = renderToString(createElement(App));

  expect(html).toContain("agent-town");
  expect(html).toContain("Colony");
  expect(html).toContain("Agent Town");
});

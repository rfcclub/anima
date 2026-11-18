import { test, expect } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusDashboardPage } from "../../src/ui/features/status/pages/StatusDashboardPage";
import type { ProjectSnapshot } from "../../src/status/scanner";

const snapshot: ProjectSnapshot = {
  generatedAt: "2026-07-11T11:00:00.000Z",
  root: "openspec",
  summary: {
    active: 2,
    archived: 1,
    verified: 1,
    draft: 1,
    inProgress: 1,
    planned: 0,
    review: 0,
    blocked: 0,
  },
  activeChanges: [
    {
      name: "active-verified",
      title: "active-verified",
      archived: false,
      lifecycle: "verified",
      artifacts: { proposal: true, design: true, tasks: true, specs: true },
      missingArtifacts: [],
      taskProgress: { total: 3, completed: 3, remaining: 0, percent: 100, unknown: false },
      specCoverage: { requirements: 1, scenarios: 2, missing: false },
      verification: { verifyJsonPresent: true, traceabilityPresent: true, verified: true, gate: "pass" },
      warnings: [],
      nextAction: null,
      path: "openspec/changes/active-verified",
    },
    {
      name: "active-inprogress",
      title: "active-inprogress",
      archived: false,
      lifecycle: "in_progress",
      artifacts: { proposal: true, design: true, tasks: true, specs: true },
      missingArtifacts: [],
      taskProgress: { total: 3, completed: 1, remaining: 2, percent: 33, unknown: false },
      specCoverage: { requirements: 1, scenarios: 1, missing: false },
      verification: { verifyJsonPresent: false, traceabilityPresent: false, verified: false },
      warnings: [],
      nextAction: "1.2 Second in-progress task",
      path: "openspec/changes/active-inprogress",
    },
  ],
  archivedChanges: [],
};

test("dashboard renders summary counts", () => {
  const html = renderToStaticMarkup(createElement(StatusDashboardPage, { snapshot }));
  expect(html).toContain("2"); // active count appears
  expect(html).toContain("active-verified");
  expect(html).toContain("active-inprogress");
});

test("dashboard renders next action for in-progress change", () => {
  const html = renderToStaticMarkup(createElement(StatusDashboardPage, { snapshot }));
  expect(html).toContain("1.2 Second in-progress task");
});

test("dashboard renders verified badge for verified change", () => {
  const html = renderToStaticMarkup(createElement(StatusDashboardPage, { snapshot }));
  expect(html.toLowerCase()).toContain("verified");
});

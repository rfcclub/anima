import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

// SC-306/307: the /rooms/:agent route must remount RoomScreen when the agent
// param changes, so client-side room→room navigation resets all request-scoped
// UI state (addressee, turns, bootedRef). The testable mechanism is that the
// route element is keyed by the agent param. This stack has no DOM harness, so
// we assert the structural mechanism: a RoomRoute wrapper reads useParams and
// forwards key={agent} to RoomScreen.

test("SC-306: /rooms/:agent route is keyed by agent param", () => {
  const routes = readFileSync("src/ui/app/routes.tsx", "utf8");
  // A wrapper component reads useParams and keys RoomScreen by the agent param.
  expect(routes).toMatch(/useParams/);
  expect(routes).toMatch(/key=\{agent\}/);
  expect(routes).toMatch(/RoomScreen/);
});

// SC-307: the boot effect (background image, portrait staging, transcript
// fetch, presence enter) must run on EVERY room entry, including client-side
// room→room navigation. The mechanism: key={agent} (SC-306) forces a fresh
// mount on param change, which resets bootedRef (a useRef, fresh per mount)
// and re-runs the [agentId]-keyed effects. This stack has no DOM harness
// (no React Testing Library, no jsdom), so we assert the structural
// preconditions — the route is keyed AND RoomScreen mounts an effect keyed
// on agentId (so it re-runs per room). Full behavioral verification (effect
// actually fires on remount) is manual.
test("SC-307: RoomScreen mounts an agentId-keyed boot effect (re-runs on remount)", () => {
  const routes = readFileSync("src/ui/app/routes.tsx", "utf8");
  const room = readFileSync("src/ui/features/castle/pages/RoomScreen.tsx", "utf8");
  // The remount mechanism (SC-306) is what re-triggers the boot effect.
  expect(routes).toMatch(/key=\{agent\}/);
  // RoomScreen has a mount-time effect keyed on agentId (boot + presence).
  expect(room).toMatch(/useEffect/);
  expect(room).toMatch(/\[agentId\]/);
  // The boot guard uses a ref that resets on fresh mount (key-forced remount).
  expect(room).toMatch(/bootedRef/);
});

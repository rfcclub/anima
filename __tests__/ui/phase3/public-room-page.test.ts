import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

describe("SC-002 (feature-pages-as-tsx): PublicRoomPage", () => {
  test("is a React page with no inline script", () => {
    expect(existsSync("src/ui/features/town/pages/PublicRoomPage.tsx")).toBe(true);
    const src = readFileSync("src/ui/features/town/pages/PublicRoomPage.tsx", "utf8");
    expect(src).toContain("export function PublicRoomPage");
    expect(src).not.toContain("<script>");
  });

  test("does not dim the common-room background; log dialog is hide/unhide, default collapsed", () => {
    const src = readFileSync("src/ui/features/town/pages/PublicRoomPage.tsx", "utf8");
    expect(src).not.toMatch(/linear-gradient\(\s*rgba\(26,\s*18,\s*8/);
    expect(src).toContain("data-testid=\"public-room-app-dialog\"");
    expect(src).toContain("data-testid=\"public-room-log-toggle\"");
    expect(src).toMatch(/useState\(true\)/);
    expect(src).toMatch(/!logCollapsed[\s\S]*data-testid=\"public-room-app-dialog\"/);
  });

  // Regression: the Bridge marker shows the
  // "cleo" badge while the room itself renders empty. The map folds both
  // gates (gate_world + gate_machine) into the Bridge sprite (lib/
  // public-places.ts), but this page read only gate_world — so anyone at
  // gate_machine (a common wander destination) was invisible inside the room.
  // Occupants MUST come from the same mapping the map uses.
  test("occupants come from the sprite's full place set, shared with the map", () => {
    const src = readFileSync("src/ui/features/town/pages/PublicRoomPage.tsx", "utf8");
    expect(src).toContain("occupantsForSprite");
    expect(src).not.toMatch(/presence\[placeId\]/);
  });

  test("has no agent-chat affordance in the common room", () => {
    const src = readFileSync("src/ui/features/town/pages/PublicRoomPage.tsx", "utf8");
    expect(src).not.toContain("/api/talk");
    expect(src).not.toContain("/api/turns");
    expect(src).not.toContain("Speak with");
    expect(src).not.toContain("href={\"/rooms/\"");
    expect(src).not.toContain("onSend");
    expect(src).not.toContain("sendMessage");
  });

  test("exit is a mid-edge castle door back to /castle, not a header chip", () => {
    const src = readFileSync("src/ui/features/town/pages/PublicRoomPage.tsx", "utf8");
    expect(src).toContain('data-testid="public-room-exit"');
    expect(src).toContain('href="/castle"');
    expect(src).not.toMatch(/href="\/(?!castle)/);
    expect(src).toContain("◂ Castle");
    // Door sits on the screen edge, not next to the log toggle.
    expect(src).not.toMatch(/public-room-log-toggle[\s\S]{0,800}public-room-exit/);
    expect(src).toMatch(/public-room-exit[\s\S]{0,500}(fixed|absolute)/);
    expect(src).toMatch(/public-room-exit[\s\S]{0,500}(50%|top-1\/2)/);
    expect(src).toMatch(/data-testid="public-room-exit"[\s\S]{0,220}text-2xl/);
    expect(src).not.toMatch(/data-testid="public-room-exit"[\s\S]{0,220}text-\[11px\]/);
  });
});

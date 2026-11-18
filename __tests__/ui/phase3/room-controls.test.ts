import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

describe("RoomControls: Castle session controls (New/Compact/Model)", () => {
  test("is a React component with no inline script", () => {
    expect(existsSync("src/ui/features/castle/components/RoomControls.tsx")).toBe(true);
    const src = readFileSync("src/ui/features/castle/components/RoomControls.tsx", "utf8");
    expect(src).toContain("export function RoomControls");
    expect(src).not.toContain("<script>");
  });

  test("reuses Town's existing session endpoints, no new backend route", () => {
    const src = readFileSync("src/ui/features/castle/components/RoomControls.tsx", "utf8");
    expect(src).toContain("/api/${cmd}/");
    expect(src).toContain('"new" | "compact"');
    expect(src).toContain("/api/config/");
    expect(src).toContain("/api/models");
    expect(src).toContain("/api/status");
  });

  test("has toggle, new, compact, and model select affordances", () => {
    const src = readFileSync("src/ui/features/castle/components/RoomControls.tsx", "utf8");
    expect(src).toContain('data-testid="room-controls-toggle"');
    expect(src).toContain('data-testid="room-controls-new"');
    expect(src).toContain('data-testid="room-controls-compact"');
    expect(src).toContain('data-testid="room-controls-model"');
  });

  test("uses CASTLE style tokens, no raw hex colors", () => {
    const src = readFileSync("src/ui/features/castle/components/RoomControls.tsx", "utf8");
    expect(src).toContain("CASTLE.cream");
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}(?!\w)/);
  });

  test("is wired into RoomScreen", () => {
    const src = readFileSync("src/ui/features/castle/pages/RoomScreen.tsx", "utf8");
    expect(src).toContain("RoomControls");
    expect(src).toMatch(/<RoomControls agentId={agentId}\s*\/>/);
  });
});

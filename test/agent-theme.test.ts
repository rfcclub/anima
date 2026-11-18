import { test, expect } from "bun:test";
import type { AgentMood } from "../src/types/agent-response";
import type { AgentTheme } from "../src/types/agent-theme";
import { abelTheme } from "../src/config/themes/abel";
import { brunoTheme } from "../src/config/themes/bruno";

test("AgentTheme type has required fields", () => {
  const theme: AgentTheme = {
    colors: { primary: "#000", secondary: "#fff", accent: "#e00", background: "#111", text: "#eee" },
    fontStyle: "sans-serif",
    defaultMood: "cool",
    portraitPosition: "center",
  };
  expect(theme.colors.primary).toBe("#000");
  expect(theme.defaultMood).toBe("cool");
});

test("2B theme is steel blue / silver with cool default", () => {
  expect(abelTheme.defaultMood).toBe("cool");
  expect(abelTheme.colors.primary).toBe("#4a6fa5");
  expect(abelTheme.colors.secondary).toBe("#a0b4c8");
  expect(abelTheme.portraitPosition).toBe("center");
});

test("2B theme has all required color fields", () => {
  const requiredColors = ["primary", "secondary", "accent", "background", "text"];
  for (const color of requiredColors) {
    expect(abelTheme.colors).toHaveProperty(color);
    expect(typeof abelTheme.colors[color as keyof typeof abelTheme.colors]).toBe("string");
  }
});

test("Bruno theme is warm gold / amber with warm default", () => {
  expect(brunoTheme.defaultMood).toBe("warm");
  expect(brunoTheme.colors.primary).toBe("#c8923c");
  expect(brunoTheme.colors.secondary).toBe("#f0d68e");
  expect(brunoTheme.portraitPosition).toBe("center");
});

test("Bruno theme has all required color fields", () => {
  const requiredColors = ["primary", "secondary", "accent", "background", "text"];
  for (const color of requiredColors) {
    expect(brunoTheme.colors).toHaveProperty(color);
    expect(typeof brunoTheme.colors[color as keyof typeof brunoTheme.colors]).toBe("string");
  }
});

test("AgentMood type is imported from agent-response, not duplicated", () => {
  // AgentMood should be a single definition shared across the codebase
  const validMoods: AgentMood[] = ["warm", "cool", "dark", "bright", "neutral"];
  expect(validMoods).toHaveLength(5);
  // AgentTheme.defaultMood uses AgentMood type, ensuring type consistency
  const theme: AgentTheme = {
    colors: { primary: "#000", secondary: "#fff", accent: "#e00", background: "#111", text: "#eee" },
    fontStyle: "sans-serif",
    defaultMood: "warm",
    portraitPosition: "center",
  };
  expect(theme.defaultMood).toBe("warm");
});

test("themes can be applied as CSS custom properties", () => {
  const cssVars = (theme: AgentTheme): Record<string, string> => ({
    "--stage-primary": theme.colors.primary,
    "--stage-secondary": theme.colors.secondary,
    "--stage-accent": theme.colors.accent,
    "--stage-background": theme.colors.background,
    "--stage-text": theme.colors.text,
    "--stage-font": theme.fontStyle,
    "--stage-default-mood": theme.defaultMood,
    "--stage-portrait-position": theme.portraitPosition,
  });

  const vars = cssVars(abelTheme);
  expect(vars["--stage-primary"]).toBe("#4a6fa5");
  expect(vars["--stage-default-mood"]).toBe("cool");
});

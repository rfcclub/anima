import { test, expect } from "bun:test";
import {
  parseVNResponse,
  extractSpokenText,
  detectDecline,
  renderMarkdown,
} from "../../src/ui/features/castle/lib/parse-vn-response";

test("SC-502: UI re-exports parser from narrative module", () => {
  expect(parseVNResponse('{"text":"hi"}').text).toBe("hi");
  expect(extractSpokenText("hi")).toBe("hi");
  expect(detectDecline("...")).toBe(true);
});

test("renderMarkdown stays local in UI module", () => {
  expect(typeof renderMarkdown).toBe("function");
  expect(renderMarkdown("**x**")).toContain("<strong>");
});

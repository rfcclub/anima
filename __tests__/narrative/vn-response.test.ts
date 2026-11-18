import { test, expect } from "bun:test";
import { parseVNResponse, extractSpokenText, detectDecline } from "../../src/narrative/vn-response";

test("SC-201: JSON decline {text:'...'} is detected", () => {
  expect(detectDecline('{"text":"...","mood":"neutral"}')).toBe(true);
});

test("SC-202: empty text inside VN JSON is decline", () => {
  expect(detectDecline('{"text":"","mood":"neutral"}')).toBe(true);
});

test("SC-204: real answer with text field is not decline", () => {
  expect(detectDecline('{"text":"I think so too.","mood":"warm","choices":null}')).toBe(false);
});

test("SC-205: no-JSON reply degrades to raw text, not decline", () => {
  expect(detectDecline("Hello, how are you today?")).toBe(false);
  expect(extractSpokenText("Hello")).toBe("Hello");
});

test("SC-203: non-VN plain-text decline works", () => {
  expect(detectDecline("...")).toBe(true);
  expect(detectDecline("  ...  ")).toBe(true);
});

test("parseVNResponse: fenced json block", () => {
  const r = parseVNResponse('Some intro\n```json\n{"text":"hi","choices":[{"label":"A","value":"a"}]}\n```');
  expect(r.text).toBe("hi");
  expect(r.choices).toEqual([{ label: "A", value: "a" }]);
  expect(r.narrative).toBe("Some intro");
});

test("SC-206: unicode ellipsis is not decline", () => {
  expect(detectDecline('{"text":"…","mood":"neutral"}')).toBe(false);
});

test("SC-207: quoted literal is not decline", () => {
  expect(detectDecline('{"text":"\\"...\\"","mood":"neutral"}')).toBe(false);
});

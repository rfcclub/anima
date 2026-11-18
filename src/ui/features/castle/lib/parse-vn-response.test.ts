import { test, expect } from "bun:test";
import { parseVNResponse } from "./parse-vn-response";

test("no JSON fence → narrative is full content, empty choices/text", () => {
  const r = parseVNResponse("Hello Owner 😊\n\nI am here.");
  expect(r.narrative).toBe("Hello Owner 😊\n\nI am here.");
  expect(r.text).toBe("");
  expect(r.choices).toEqual([]);
});

test("fenced JSON block → splits narrative from text + choices", () => {
  const content = `He steps closer.\n\n\`\`\`json\n{"text":"Take your time.","choices":[{"label":"Go for a walk","value":"walk"}]}\n\`\`\``;
  const r = parseVNResponse(content);
  expect(r.narrative).toBe("He steps closer.");
  expect(r.text).toBe("Take your time.");
  expect(r.choices).toEqual([{ label: "Go for a walk", value: "walk" }]);
});

test("JSON without choices → empty choices array", () => {
  const content = "Narrative here.\n\n```json\n{\"text\":\"just text\",\"mood\":\"warm\"}\n```";
  const r = parseVNResponse(content);
  expect(r.text).toBe("just text");
  expect(r.mood).toBe("warm");
  expect(r.choices).toEqual([]);
});

test("malformed JSON → degrade to narrative = full content, no crash", () => {
  const content = "Some text.\n\n```json\n{not valid json}\n```";
  const r = parseVNResponse(content);
  expect(r.narrative).toBe("Some text.\n\n```json\n{not valid json}\n```");
  expect(r.text).toBe("");
  expect(r.choices).toEqual([]);
});

test("JSON block only, no narrative before it", () => {
  const content = "```json\n{\"text\":\"only dialogue\"}\n```";
  const r = parseVNResponse(content);
  expect(r.narrative).toBe("");
  expect(r.text).toBe("only dialogue");
});

test("carries mood/emotion/action fields through", () => {
  const content = "```json\n{\"text\":\"hi\",\"mood\":\"warm\",\"emotion\":\"blush\",\"action\":\"present_choice\"}\n```";
  const r = parseVNResponse(content);
  expect(r.mood).toBe("warm");
  expect(r.emotion).toBe("blush");
  expect(r.action).toBe("present_choice");
});

test("raw JSON (no fence) → extracts text field, ignores mood/emotion", () => {
  const content = `{\n  "text": "You are right — colony-mesh is not needed.",\n  "mood": "warm",\n  "emotion": "blush"\n}`;
  const r = parseVNResponse(content);
  expect(r.text).toBe("You are right — colony-mesh is not needed.");
  expect(r.mood).toBe("warm");
  expect(r.emotion).toBe("blush");
  expect(r.narrative).toBe("");
  expect(r.choices).toEqual([]);
});

test("raw JSON with \\n inside text → preserved as literal newline", () => {
  const content = `{"text": "Line 1\\nLine 2", "mood": "warm"}`;
  const r = parseVNResponse(content);
  expect(r.text).toBe("Line 1\nLine 2");
});

test("raw JSON with choices → choices extracted", () => {
  const content = `{"text":"pick one","choices":[{"label":"A","value":"a"},{"label":"B","value":"b"}]}`;
  const r = parseVNResponse(content);
  expect(r.text).toBe("pick one");
  expect(r.choices).toEqual([{ label: "A", value: "a" }, { label: "B", value: "b" }]);
});

test("narrative text before raw JSON → both preserved", () => {
  const content = `He steps closer.\n\n{"text":"Take your time.","mood":"warm"}`;
  const r = parseVNResponse(content);
  expect(r.narrative).toBe("He steps closer.");
  expect(r.text).toBe("Take your time.");
});

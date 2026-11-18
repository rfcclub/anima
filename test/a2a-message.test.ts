import { test, expect } from "bun:test";
import { parseA2AMessage, A2AParseError } from "../src/meeting/types";

test("parse valid A2A message with all fields", () => {
  const md = `---
from: bruno
to: eli
timestamp: 2026-05-17T12:00:00Z
topic: rate-limiter-design
turn: 3
---

This is the message body.

It can have multiple paragraphs.`;

  const msg = parseA2AMessage(md);
  expect(msg.from).toBe("bruno");
  expect(msg.to).toBe("eli");
  expect(msg.timestamp).toBe("2026-05-17T12:00:00.000Z");
  expect(msg.topic).toBe("rate-limiter-design");
  expect(msg.turn).toBe(3);
  expect(msg.body).toBe("This is the message body.\n\nIt can have multiple paragraphs.");
});

test("parse with broadcast 'all' recipient", () => {
  const md = `---
from: sam
to: all
timestamp: 2026-05-17T09:00:00Z
topic: daily-standup
turn: 1
---

Good morning colony!`;

  const msg = parseA2AMessage(md);
  expect(msg.to).toBe("all");
  expect(msg.body).toBe("Good morning colony!");
});

test("parse with turn 0", () => {
  const md = `---
from: milo
to: bruno
timestamp: 2026-05-17T08:00:00Z
topic: init
turn: 0
---

Starting the conversation.`;

  const msg = parseA2AMessage(md);
  expect(msg.turn).toBe(0);
});

test("throws on missing YAML frontmatter", () => {
  expect(() => parseA2AMessage("Just plain text without frontmatter")).toThrow(A2AParseError);
  expect(() => parseA2AMessage("Just plain text without frontmatter")).toThrow(
    "missing YAML frontmatter delimiter",
  );
});

test("throws on unclosed frontmatter (no trailing ---)", () => {
  const md = `---
from: bruno
to: eli
But no closing delimiter`;

  expect(() => parseA2AMessage(md)).toThrow(A2AParseError);
  expect(() => parseA2AMessage(md)).toThrow("unclosed YAML frontmatter");
});

test("throws on missing required field", () => {
  const md = `---
from: bruno
timestamp: 2026-05-17T12:00:00Z
topic: test
turn: 1
---

Missing the 'to' field.`;

  expect(() => parseA2AMessage(md)).toThrow(A2AParseError);
  expect(() => parseA2AMessage(md)).toThrow("missing required field: to");
});

test("throws when 'from' field is missing", () => {
  const md = `---
to: eli
timestamp: 2026-05-17T12:00:00Z
topic: test
turn: 1
---

No from field.`;

  expect(() => parseA2AMessage(md)).toThrow("missing required field: from");
});

test("throws when 'timestamp' field is missing", () => {
  const md = `---
from: bruno
to: eli
topic: test
turn: 1
---

No timestamp field.`;

  expect(() => parseA2AMessage(md)).toThrow("missing required field: timestamp");
});

test("throws when 'topic' field is missing", () => {
  const md = `---
from: bruno
to: eli
timestamp: 2026-05-17T12:00:00Z
turn: 1
---

No topic field.`;

  expect(() => parseA2AMessage(md)).toThrow("missing required field: topic");
});

test("throws when 'turn' field is missing", () => {
  const md = `---
from: bruno
to: eli
timestamp: 2026-05-17T12:00:00Z
topic: test
---

No turn field.`;

  expect(() => parseA2AMessage(md)).toThrow("missing required field: turn");
});

test("throws when 'turn' is not an integer", () => {
  const md = `---
from: bruno
to: eli
timestamp: 2026-05-17T12:00:00Z
topic: test
turn: "three"
---

Turn is a string.`;

  expect(() => parseA2AMessage(md)).toThrow(A2AParseError);
  expect(() => parseA2AMessage(md)).toThrow("field 'turn' must be an integer");
});

test("throws when 'turn' is a float", () => {
  const md = `---
from: bruno
to: eli
timestamp: 2026-05-17T12:00:00Z
topic: test
turn: 3.5
---

Turn is a float.`;

  expect(() => parseA2AMessage(md)).toThrow("field 'turn' must be an integer");
});

test("throws when 'from' is not a string", () => {
  const md = `---
from: 42
to: eli
timestamp: 2026-05-17T12:00:00Z
topic: test
turn: 1
---

From is a number.`;

  expect(() => parseA2AMessage(md)).toThrow("field 'from' must be a string");
});

test("throws on invalid YAML in frontmatter", () => {
  const md = `---
	invalid: yaml: [
  bad indentation
---

Body text.`;

  expect(() => parseA2AMessage(md)).toThrow(A2AParseError);
  expect(() => parseA2AMessage(md)).toThrow("invalid YAML frontmatter");
});

test("throws when frontmatter is not an object (scalar YAML)", () => {
  const md = `---
just a string
---

Body text.`;

  expect(() => parseA2AMessage(md)).toThrow(A2AParseError);
  expect(() => parseA2AMessage(md)).toThrow("YAML frontmatter must be an object");
});

test("handles empty body", () => {
  const md = `---
from: bruno
to: eli
timestamp: 2026-05-17T12:00:00Z
topic: test
turn: 1
---`;

  const msg = parseA2AMessage(md);
  expect(msg.body).toBe("");
});

test("A2AParseError has correct name", () => {
  const err = new A2AParseError("test error");
  expect(err.name).toBe("A2AParseError");
  expect(err.message).toBe("test error");
  expect(err).toBeInstanceOf(Error);
});

test("handles frontmatter with extra fields gracefully", () => {
  const md = `---
from: bruno
to: eli
timestamp: 2026-05-17T12:00:00Z
topic: test
turn: 1
extra_field: ignored
---

Body.`;

  const msg = parseA2AMessage(md);
  expect(msg.from).toBe("bruno");
  expect(msg.body).toBe("Body.");
});

test("preserves markdown in body", () => {
  const md = `---
from: cleo
to: all
timestamp: 2026-05-17T10:00:00Z
topic: architecture
turn: 2
---

# Architecture Proposal

## Overview

- Point 1
- Point 2

\`\`\`ts
const x = 1;
\`\`\``;

  const msg = parseA2AMessage(md);
  expect(msg.body).toContain("# Architecture Proposal");
  expect(msg.body).toContain("```ts");
  expect(msg.body).toContain("- Point 1");
});

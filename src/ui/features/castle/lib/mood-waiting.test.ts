import { test, expect } from "bun:test";
import { whimsicalStatusWord, waitingStatusPhrase } from "./mood-waiting";

test("whimsicalStatusWord returns a non-empty word", () => {
  const word = whimsicalStatusWord();
  expect(typeof word).toBe("string");
  expect(word.length).toBeGreaterThan(0);
});

test("waitingStatusPhrase escalates thinking -> still thinking -> thinking more -> remote slow response", () => {
  expect(waitingStatusPhrase(0)).toBe("thinking");
  expect(waitingStatusPhrase(6)).toBe("thinking");
  expect(waitingStatusPhrase(7)).toBe("still thinking");
  expect(waitingStatusPhrase(17)).toBe("still thinking");
  expect(waitingStatusPhrase(18)).toBe("thinking more");
  expect(waitingStatusPhrase(31)).toBe("thinking more");
  expect(waitingStatusPhrase(32)).toBe("remote slow response");
  expect(waitingStatusPhrase(120)).toBe("remote slow response");
});

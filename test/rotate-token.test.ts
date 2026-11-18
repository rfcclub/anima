import { test, expect } from "bun:test";
import { getBearerToken, rotateBearerToken } from "../src/services/abel-mem";

test("getBearerToken returns a valid UUID", () => {
  const token = getBearerToken();
  expect(token).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
});

test("rotateBearerToken generates a new token", () => {
  const oldToken = getBearerToken();
  const newToken = rotateBearerToken();

  expect(newToken).not.toBe(oldToken);
  expect(newToken).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
});

test("after rotation, old token no longer authorizes", () => {
  const oldToken = getBearerToken();
  rotateBearerToken();

  // Simulate authorization check
  function authorizeRequest(authHeader: string | null): boolean {
    if (!authHeader) return false;
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) return false;
    const token = match[1];
    const expected = getBearerToken();
    return token === expected;
  }

  expect(authorizeRequest(`Bearer ${oldToken}`)).toBe(false);
  expect(authorizeRequest(`Bearer ${getBearerToken()}`)).toBe(true);
});

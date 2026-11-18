import { describe, expect, test } from "bun:test";
import {
  assertActiveJoinIntent,
  assertRemoteRecallRequest,
  assertRemoteRememberRequest,
} from "../../../src/identity-runtime/contract/remote-continuity.ts";

describe("remote Continuity contract", () => {
  test("accepts active client intent without client-owned mode or scopes", () => {
    expect(assertActiveJoinIntent({
      identity: "eli",
      surfaceId: "windows-codex",
      message: "Review this file.",
      hostContext: ["cwd=/repo"],
    })).toEqual({
      identity: "eli",
      surfaceId: "windows-codex",
      message: "Review this file.",
      hostContext: ["cwd=/repo"],
    });
  });

  test("rejects empty join intent and malformed bounded remember input", () => {
    expect(() => assertActiveJoinIntent({
      identity: "eli",
      surfaceId: "windows-codex",
      message: "",
    })).toThrow("active join message is required");

    expect(() => assertRemoteRememberRequest({
      grantId: "grant-1",
      stateHash: "state-1",
      idempotencyKey: "remember-1",
      entry: { scope: "scent", content: "remember this", tags: [], confidence: 1, source: "test" },
    })).not.toThrow();

    expect(() => assertRemoteRememberRequest({
      grantId: "grant-1",
      stateHash: "",
      idempotencyKey: "remember-1",
      entry: { scope: "scent", content: "remember this", tags: [], confidence: 1, source: "test" },
    })).toThrow("remote remember stateHash is required");
  });

  test("accepts a bounded recall request and rejects empty recall fields", () => {
    expect(assertRemoteRecallRequest({
      grantId: "grant-1",
      stateHash: "state-1",
      query: "what happened?",
      substrateScope: "episodic_memory",
    })).toEqual({
      grantId: "grant-1",
      stateHash: "state-1",
      query: "what happened?",
      substrateScope: "episodic_memory",
    });

    expect(() => assertRemoteRecallRequest({
      grantId: "grant-1",
      stateHash: "state-1",
      query: "",
      substrateScope: "episodic_memory",
    })).toThrow("remote recall query is required");

    expect(() => assertRemoteRecallRequest({
      grantId: "grant-1",
      stateHash: "state-1",
      query: "what happened?",
      substrateScope: "",
    })).toThrow("remote recall substrateScope is required");
  });
});

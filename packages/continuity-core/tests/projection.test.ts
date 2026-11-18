import { describe, expect, test } from "bun:test";
import {
  assertProjectionCompileRequest,
  type ProjectionCompileRequest,
  type ProjectionCompiler,
  type ProjectionManifestCompiler,
} from "../src/projection";

describe("identity projection compiler contract", () => {
  test("keeps task composition separate from runtime join metadata", () => {
    const request: ProjectionCompileRequest = {
      identity: "eli",
      surfaceId: "anima",
      mode: "edit",
      message: "implement the canary",
      cartridgeOverride: "programmer",
      task: "identity-host-integration",
    };

    expect(assertProjectionCompileRequest(request)).toEqual(request);
  });

  test("rejects incomplete composition requests instead of supplying defaults", () => {
    expect(() => assertProjectionCompileRequest({
      identity: "eli",
      surfaceId: "anima",
      mode: "edit",
      message: "",
    })).toThrow("message is required");
  });

  test("distinguishes the identity compiler from the legacy manifest compiler", () => {
    const contracts: {
      identity?: ProjectionCompiler<unknown>;
      manifest?: ProjectionManifestCompiler;
    } = {};
    expect(contracts).toEqual({});
  });
});

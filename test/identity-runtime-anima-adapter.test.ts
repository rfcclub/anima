import { expect, test } from "bun:test";
import { joinAnimaIdentityRuntime, ProjectionMismatchError } from "../src/identity-runtime/anima-adapter";
import type { RuntimeProjection } from "../packages/identity-runtime/src/runtime";

const projection: RuntimeProjection = {
  prompt: "Eli projection",
  promptStaticHash: "static",
  kernelVersion: "kernel",
  cartridgeVersions: {},
  substrateViewVersion: "view",
  readScopes: [],
  writeScopes: ["scent"],
  proposalScopes: [],
  declaredSubstrateScopes: [],
  scopeDeclarationStatus: "unimplemented",
};

test("IHI-04 sends a distinct compile envelope and uses only the runtime projection", async () => {
  let received: unknown;
  const result = await joinAnimaIdentityRuntime({
    async join(input) {
      received = input;
      return { projection: "Eli projection", projectionId: "projection", stateHash: "state", leaseId: "lease", expiresAt: 1 };
    },
  }, {
    clientId: "anima:eli",
    surfaceId: "anima",
    compile: { identity: "eli", surfaceId: "anima", mode: "edit", message: "implement" },
    projection,
  });

  expect(received).toEqual({
    clientId: "anima:eli",
    surfaceId: "anima",
    compile: { identity: "eli", surfaceId: "anima", mode: "edit", message: "implement" },
    projection,
  });
  expect(result.projection).toBe("Eli projection");
});

test("IHI-04 blocks a compiler/runtime mismatch before a provider can be invoked", async () => {
  await expect(joinAnimaIdentityRuntime({
    async join() {
      return { projection: "wrong projection", projectionId: "projection", stateHash: "state", leaseId: "lease", expiresAt: 1 };
    },
  }, {
    clientId: "anima:eli",
    surfaceId: "anima",
    compile: { identity: "eli", surfaceId: "anima", mode: "edit", message: "implement" },
    projection,
  })).rejects.toBeInstanceOf(ProjectionMismatchError);
});

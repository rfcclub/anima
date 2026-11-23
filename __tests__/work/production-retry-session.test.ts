import { describe, expect, test } from "bun:test";
import { MeshJobsOfflineError } from "../../src/mesh-jobs/client";
import { createProductionRetrySession } from "../../src/work/production";

describe("production retry session", () => {
  test("reads the producer registration once and keeps its capability across a rejoin", async () => {
    let calls = 0;
    let inbox = { address: "queue@anima", capability: "test-first" };
    const authorization: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      authorization.push((init!.headers as Record<string, string>).authorization!);
      return Response.json({ id: "job" });
    };
    const session = createProductionRetrySession("http://mesh.invalid", () => {
      calls++;
      return inbox;
    }, fetchImpl);
    inbox = { address: "other@anima", capability: "test-second" };
    await session.getJob("job");
    await session.enqueue({ type: "revise" });
    expect(calls).toBe(1);
    expect(session.enqueuer).toBe("queue@anima");
    expect(authorization).toEqual(["Bearer test-first", "Bearer test-first"]);
  });

  test("keeps the same producer capability if the returned registration object is mutated", async () => {
    const inbox = { address: "queue@anima", capability: "test-first" };
    const authorization: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      authorization.push((init!.headers as Record<string, string>).authorization!);
      return Response.json({ id: "job" });
    };
    const session = createProductionRetrySession("http://mesh.invalid", () => inbox, fetchImpl);
    inbox.address = "other@anima";
    inbox.capability = "test-second";
    await session.getJob("job");
    await session.enqueue({ type: "revise" });
    expect(session.enqueuer).toBe("queue@anima");
    expect(authorization).toEqual(["Bearer test-first", "Bearer test-first"]);
  });

  test.each([null, { address: "", capability: "test-first" }, { address: "queue@anima", capability: "" }])(
    "refuses an unavailable or incomplete registration",
    (inbox) => {
      expect(() => createProductionRetrySession("http://mesh.invalid", () => inbox)).toThrow(MeshJobsOfflineError);
    },
  );
});

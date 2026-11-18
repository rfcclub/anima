import { describe, test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileCoreIdentity, readCoreIdentityProjection } from "./core-identity-compiler";
import { DEFAULT_WRITE_SCOPES } from "../memory/scoped-store";

async function seedFixture(dir: string): Promise<{ agoraRoot: string; cacheDir: string; identityRuntimeRoot: string }> {
  await mkdir(join(dir, "codex-one"), { recursive: true });
  const cacheDir = join(dir, "identityCache");
  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(dir, "SOUL.md"), "soul body", "utf-8");
  await writeFile(join(dir, "codex-one/KERNEL.md"), "kernel body", "utf-8");
  await writeFile(join(dir, "codex-one/JUDGMENTS.md"), "### [judgment] A\n\n***CORE***\n\nbody a\n", "utf-8");
  await writeFile(
    join(dir, "codex-one/OWNER.md"),
    [
      "### [preference] Continuity should become infrastructure\n\nb1",
      "### [preference] Collaboration should be warm, direct, and operational\n\nb2",
      "### [preference] Eli and Owner naming anchor\n\nb3",
      "### [preference] Eli may proactively preserve useful continuity\n\nb4",
      // Same heading as the required title in core-identity-compiler.ts (written as \u escapes).
      '### [preference] Eli x\u01b0ng "em", g\u1ecdi Owner l\u00e0 "anh"\n\nb5',
      "### [preference] Optional improvements are real invitations, not pressure\n\nb6",
    ].join("\n\n") + "\n",
    "utf-8",
  );
  await writeFile(join(dir, "codex-one/SCARS.md"), "### [scar] S\n\n***CORE***\n\nbody s\n", "utf-8");
  // identityRuntimeRoot is mkdtemp-scoped so compileCoreIdentity()'s
  // best-effort symlink step never touches the real ~/.identityRuntime/.
  return { agoraRoot: dir, cacheDir, identityRuntimeRoot: join(dir, ".identityRuntime") };
}

describe("readCoreIdentityProjection", () => {
  test("SC-010/013-018: fresh manifest serves without recompiling and maps fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "core-identity-service-"));
    const paths = await seedFixture(dir);
    await compileCoreIdentity(paths);

    const projection = await readCoreIdentityProjection(paths);

    expect(projection.prompt).toBe(await readFile(join(paths.cacheDir, "CORE_IDENTITY.md"), "utf-8"));
    expect(projection.cartridgeVersions).toEqual({});
    expect(projection.readScopes).toEqual(["episode", "observation"]);
    expect(projection.proposalScopes).toEqual([]);
    expect(projection.declaredSubstrateScopes).toEqual(["episodic_memory"]);
    expect(projection.scopeDeclarationStatus).toBe("implemented");
    expect(projection.writeScopes).toEqual([...DEFAULT_WRITE_SCOPES]);
  });

  test("SC-011: a changed source triggers synchronous recompile before returning", async () => {
    const dir = await mkdtemp(join(tmpdir(), "core-identity-service-"));
    const paths = await seedFixture(dir);
    await compileCoreIdentity(paths);
    await writeFile(join(dir, "SOUL.md"), "soul body v2", "utf-8");

    const projection = await readCoreIdentityProjection(paths);
    expect(projection.prompt.startsWith("soul body v2")).toBe(true);
  });

  test("SC-012: a missing manifest triggers synchronous recompile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "core-identity-service-"));
    const paths = await seedFixture(dir);
    const projection = await readCoreIdentityProjection(paths);
    expect(projection.prompt).toContain("soul body");
  });

  test("SC-024/025: a corrupted CORE_IDENTITY.md with matching source hashes is treated as stale", async () => {
    const dir = await mkdtemp(join(tmpdir(), "core-identity-service-"));
    const paths = await seedFixture(dir);
    await compileCoreIdentity(paths);
    await writeFile(join(paths.cacheDir, "CORE_IDENTITY.md"), "truncated garbage", "utf-8");

    const projection = await readCoreIdentityProjection(paths);
    expect(projection.prompt).not.toBe("truncated garbage");
    expect(projection.prompt).toContain("soul body");
  });

  test("the identityRuntime symlink stays pointed at the canonical file even when the cache is already fresh (no recompile)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "core-identity-service-"));
    const paths = await seedFixture(dir);
    const firstManifest = await compileCoreIdentity(paths); // creates manifest + symlink

    // Simulate pre-existing production state: the compiled cache is already
    // fresh, but the symlink is missing (e.g. content compiled before this
    // symlink feature existed in the codebase).
    await rm(join(paths.identityRuntimeRoot, "eli", "CORE_IDENTITY"));

    const projection = await readCoreIdentityProjection(paths);

    expect(projection.promptStaticHash).toBe(firstManifest.coreHash); // proves no recompile happened
    const linked = await readlink(join(paths.identityRuntimeRoot, "eli", "CORE_IDENTITY"));
    expect(linked).toBe(join(paths.cacheDir, "CORE_IDENTITY.md"));
  });
});

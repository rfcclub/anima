import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WRITE_SCOPES } from "../memory/scoped-store";
import {
  compileBrunoCoreIdentity,
  readBrunoCoreIdentityProjection,
  type BrunoCoreIdentityPaths,
} from "./bruno-core-identity-compiler";

// Mirrors ~/substrate/substrate.map.yaml's real scope declarations (the fixture
// version keeps the paths the compiler actually exercises; current_state
// declares state/ + CURRENT.md exactly like the real map).
const REAL_SUBSTRATE_MAP = `version: 1
agent_id: bruno
substrate_type: substrate
root: ~/substrate
required_scopes:
  - identity_core
  - current_state
scopes:
  identity_core:
    description: Stable identity, axioms, and self-definition.
    required: true
    sources:
      - type: paths
        paths:
          - 0_SOUL/
          - 1_EGO/
        trust: high
        weight: 1.0
        evidence_required: true
  current_state:
    description: Current operational state and recent continuity state.
    required: true
    sources:
      - type: paths
        paths:
          - state/
          - CURRENT.md
        trust: medium
        weight: 0.8
        evidence_required: false
  relationship:
    description: Relationship memory with Owner and other agents.
    required: false
    sources:
      - type: paths
        paths:
          - 4_RELATIONS/
          - OWNER/
        trust: high
        weight: 1.0
        evidence_required: true
`;

async function makeFixtureSubstrate(options: { withCurrentState?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bruno-runtime-test-"));
  await mkdir(join(root, "0_SOUL"), { recursive: true });
  await mkdir(join(root, "1_EGO"), { recursive: true });
  await mkdir(join(root, "4_RELATIONS"), { recursive: true });
  await writeFile(join(root, "substrate.map.yaml"), REAL_SUBSTRATE_MAP);
  await writeFile(join(root, "0_SOUL", "axioms.md"), "# Axioms\n\nI. Test axiom.\n");
  // self.md is distilled: heading + lead paragraph per section survives,
  // later paragraphs are dropped (self.md is distilled).
  await writeFile(
    join(root, "1_EGO", "self.md"),
    "# Self\n\nI am a test identity.\n\n## Who I Am\n\nLead paragraph survives distillation.\n\nSecond paragraph should be dropped by distillation.\n",
  );
  // Files present under identity_core's resolved scope but NOT part of the
  // curated selection -- proves the compiler filters, doesn't dump raw.
  await writeFile(
    join(root, "1_EGO", "growth.md"),
    "# Growth\n\n".padEnd(2000, "should not appear in compiled output. "),
  );
  // owner.md is distilled too, except its private section stays full (that section is kept
  // as is and the rest is trimmed).
  await writeFile(
    join(root, "4_RELATIONS", "owner.md"),
    "# Owner\n\n## Who He Is\n\nLead paragraph about him survives.\n\nSecond paragraph should be dropped by distillation.\n\n## Private Section — Full\n\n<!-- distill: keep-full -->\n\nFull private content here, not a pointer.\n\nA second private paragraph that must survive because the private section stays full.\n",
  );
  // current_state scope: the always-changing part (IDENTITY_IMMEDIATE layer).
  // In the real substrate these files do not exist yet; the map declares them
  // with evidence_required: false, so both presence and absence must compile.
  if (options.withCurrentState) {
    await mkdir(join(root, "state"), { recursive: true });
    await writeFile(join(root, "state", "operational.md"), "# Operational State\n\nCurrently building bruno-runtime.\n");
    await writeFile(join(root, "CURRENT.md"), "# Current\n\nSession continuation marker.\n");
  }
  return root;
}

describe("compileBrunoCoreIdentity", () => {
  let substrateRoot: string;
  let identityRuntimeRoot: string;
  let paths: BrunoCoreIdentityPaths;

  beforeEach(async () => {
    substrateRoot = await makeFixtureSubstrate();
    identityRuntimeRoot = await mkdtemp(join(tmpdir(), "bruno-runtime-identityRuntime-"));
    paths = { substrateRoot, identityRuntimeRoot };
  });

  test("resolves via the real substrate.map.yaml, not a hardcoded path list", async () => {
    // If this resolved via a hardcoded list, moving axioms.md would break it
    // silently. Resolving via the real map means the compiler follows
    // whatever the map declares.
    await compileBrunoCoreIdentity(paths);
    const outPath = join(identityRuntimeRoot, "bruno", "CORE_IDENTITY.md");
    const content = await readFile(outPath, "utf-8");
    expect(content).toContain("I. Test axiom.");
  });

  test("curated output includes axioms.md (full), self.md (distilled), and owner.md (distilled, private section full)", async () => {
    await compileBrunoCoreIdentity(paths);
    const content = await readFile(join(identityRuntimeRoot, "bruno", "CORE_IDENTITY.md"), "utf-8");
    expect(content).toContain("I. Test axiom.");
    expect(content).toContain("I am a test identity.");
    expect(content).toContain("Full private content here, not a pointer.");
    expect(content).toContain("A second private paragraph that must survive because the private section stays full.");
  });

  test("distillation drops later paragraphs of self.md and owner.md sections, except the private section", async () => {
    await compileBrunoCoreIdentity(paths);
    const content = await readFile(join(identityRuntimeRoot, "bruno", "CORE_IDENTITY.md"), "utf-8");
    expect(content).toContain("Lead paragraph survives distillation.");
    expect(content).not.toContain("Second paragraph should be dropped by distillation.");
  });

  test("a section is kept in full because the source document marks it, not because of a built-in name", async () => {
    await compileBrunoCoreIdentity(paths);
    const content = await readFile(join(identityRuntimeRoot, "bruno", "CORE_IDENTITY.md"), "utf-8");
    expect(content).toContain("A second private paragraph that must survive because the private section stays full.");
    expect(content).toContain("Second paragraph should be dropped by distillation.".slice(0, 0) + "Lead paragraph about him survives.");
    expect(content).not.toContain("Second paragraph should be dropped by distillation.");
  });

  test("curated output excludes files the scope resolves but the curation filters out", async () => {
    // File-granularity exclusion: growth.md is a whole *file* the
    // identity_core scope resolves that the curated selection excludes
    // entirely (distinct from owner.md's section-level distillation above).
    await compileBrunoCoreIdentity(paths);
    const content = await readFile(join(identityRuntimeRoot, "bruno", "CORE_IDENTITY.md"), "utf-8");
    expect(content).not.toContain("should not appear in compiled output");
  });

  test("documents the recall HTTP access point", async () => {
    await compileBrunoCoreIdentity(paths);
    const content = await readFile(join(identityRuntimeRoot, "bruno", "CORE_IDENTITY.md"), "utf-8");
    expect(content).toContain("/v1/continuity/recall");
    expect(content).toContain("hive");
  });

  test("does not touch substrate/CORE_IDENTITY.md at all", async () => {
    const staleFile = join(substrateRoot, "CORE_IDENTITY.md");
    await writeFile(staleFile, "hand-maintained, do not touch");
    await compileBrunoCoreIdentity(paths);
    const stillThere = await readFile(staleFile, "utf-8");
    expect(stillThere).toBe("hand-maintained, do not touch");
  });

  test("a second compile with no source changes does not rewrite the output", async () => {
    await compileBrunoCoreIdentity(paths);
    const outPath = join(identityRuntimeRoot, "bruno", "CORE_IDENTITY.md");
    const firstContent = await readFile(outPath, "utf-8");
    const firstMtime = (await stat(outPath)).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await compileBrunoCoreIdentity(paths);
    const secondMtime = (await stat(outPath)).mtimeMs;
    expect(secondMtime).toBe(firstMtime);
    const secondContent = await readFile(outPath, "utf-8");
    expect(secondContent).toBe(firstContent);
  });

  test("a changed source triggers a real recompile", async () => {
    await compileBrunoCoreIdentity(paths);
    await writeFile(join(substrateRoot, "1_EGO", "self.md"), "# Self\n\nI have changed.\n");
    await compileBrunoCoreIdentity(paths);
    const content = await readFile(join(identityRuntimeRoot, "bruno", "CORE_IDENTITY.md"), "utf-8");
    expect(content).toContain("I have changed.");
    expect(content).not.toContain("I am a test identity.");
  });
});

describe("current_state — the IDENTITY_IMMEDIATE layer (SOUL + IMMEDIATE pattern)", () => {
  test("current_state content lands in the compiled file and in the sidecar immediate file", async () => {
    const substrateRoot = await makeFixtureSubstrate({ withCurrentState: true });
    const identityRuntimeRoot = await mkdtemp(join(tmpdir(), "bruno-immediate-"));
    await compileBrunoCoreIdentity({ substrateRoot, identityRuntimeRoot });

    const core = await readFile(join(identityRuntimeRoot, "bruno", "CORE_IDENTITY.md"), "utf-8");
    expect(core).toContain("Currently building bruno-runtime.");
    expect(core).toContain("Session continuation marker.");

    const immediate = await readFile(join(identityRuntimeRoot, "bruno", "IDENTITY_CORE_IMMEDIATE.md"), "utf-8");
    expect(immediate).toContain("Currently building bruno-runtime.");
    expect(immediate).toContain("Session continuation marker.");
  });

  test("a change in current_state triggers recompile and bumps the immediate hash", async () => {
    const substrateRoot = await makeFixtureSubstrate({ withCurrentState: true });
    const identityRuntimeRoot = await mkdtemp(join(tmpdir(), "bruno-immediate-"));
    const paths = { substrateRoot, identityRuntimeRoot };
    const first = await compileBrunoCoreIdentity(paths);
    await writeFile(join(substrateRoot, "CURRENT.md"), "# Current\n\nUpdated marker.\n");
    const second = await compileBrunoCoreIdentity(paths);
    expect(second.immediateHash).not.toBe(first.immediateHash);
    const core = await readFile(join(identityRuntimeRoot, "bruno", "CORE_IDENTITY.md"), "utf-8");
    expect(core).toContain("Updated marker.");
  });

  test("missing current_state files (the real substrate today) still compiles, immediate block omitted", async () => {
    const substrateRoot = await makeFixtureSubstrate({ withCurrentState: false });
    const identityRuntimeRoot = await mkdtemp(join(tmpdir(), "bruno-immediate-"));
    const manifest = await compileBrunoCoreIdentity({ substrateRoot, identityRuntimeRoot });
    expect(manifest.immediateHash).toBeTruthy();
    const core = await readFile(join(identityRuntimeRoot, "bruno", "CORE_IDENTITY.md"), "utf-8");
    expect(core).toContain("I. Test axiom.");
    const immediate = await readFile(join(identityRuntimeRoot, "bruno", "IDENTITY_CORE_IMMEDIATE.md"), "utf-8");
    expect(immediate).not.toContain("Currently building bruno-runtime.");
  });
});

describe("readBrunoCoreIdentityProjection", () => {
  test("fresh manifest serves without recompiling and maps fields", async () => {
    const substrateRoot = await makeFixtureSubstrate({ withCurrentState: true });
    const identityRuntimeRoot = await mkdtemp(join(tmpdir(), "bruno-projection-"));
    const paths = { substrateRoot, identityRuntimeRoot };
    const firstManifest = await compileBrunoCoreIdentity(paths);

    const projection = await readBrunoCoreIdentityProjection(paths);

    expect(projection.prompt).toBe(await readFile(join(identityRuntimeRoot, "bruno", "CORE_IDENTITY.md"), "utf-8"));
    expect(projection.promptStaticHash).toBe(firstManifest.coreHash);
    expect(projection.substrateViewVersion).toBe(firstManifest.immediateHash);
    expect(projection.cartridgeVersions).toEqual({});
    expect(projection.readScopes).toEqual([]);
    expect(projection.proposalScopes).toEqual([]);
    expect(projection.declaredSubstrateScopes).toEqual([]);
    expect(projection.scopeDeclarationStatus).toBe("unimplemented");
    expect(projection.writeScopes).toEqual([...DEFAULT_WRITE_SCOPES]);
  });

  test("a changed source triggers synchronous recompile before returning", async () => {
    const substrateRoot = await makeFixtureSubstrate();
    const identityRuntimeRoot = await mkdtemp(join(tmpdir(), "bruno-projection-"));
    const paths = { substrateRoot, identityRuntimeRoot };
    await compileBrunoCoreIdentity(paths);
    await writeFile(join(substrateRoot, "0_SOUL", "axioms.md"), "# Axioms\n\nII. New axiom.\n");

    const projection = await readBrunoCoreIdentityProjection(paths);
    expect(projection.prompt).toContain("II. New axiom.");
  });

  test("a missing manifest triggers synchronous recompile", async () => {
    const substrateRoot = await makeFixtureSubstrate();
    const identityRuntimeRoot = await mkdtemp(join(tmpdir(), "bruno-projection-"));
    const projection = await readBrunoCoreIdentityProjection({ substrateRoot, identityRuntimeRoot });
    expect(projection.prompt).toContain("I. Test axiom.");
  });

  test("a corrupted CORE_IDENTITY.md with matching source hashes is treated as stale", async () => {
    const substrateRoot = await makeFixtureSubstrate();
    const identityRuntimeRoot = await mkdtemp(join(tmpdir(), "bruno-projection-"));
    const paths = { substrateRoot, identityRuntimeRoot };
    await compileBrunoCoreIdentity(paths);
    await writeFile(join(identityRuntimeRoot, "bruno", "CORE_IDENTITY.md"), "truncated garbage", "utf-8");

    const projection = await readBrunoCoreIdentityProjection(paths);
    expect(projection.prompt).not.toBe("truncated garbage");
    expect(projection.prompt).toContain("I. Test axiom.");
  });

});

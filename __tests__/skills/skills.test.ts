import { describe, test, expect } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  discoverSkills,
  type SkillRoot,
} from "../../src/skills/discovery";
import { buildSkillCatalog } from "../../src/skills/catalog";
import { SkillSession } from "../../src/skills/session";

async function makeRoot(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `skill-${name}-`));
}

/** Create a skill directory `root/<slug>/SKILL.md` with `frontmatter` + body. */
async function writeSkill(root: string, slug: string, frontmatter: string, body = "Body content"): Promise<string> {
  const dir = join(root, slug);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`);
  return dir;
}

function project(root: string): SkillRoot {
  return { root, source: "project", trusted: true };
}
function user(root: string): SkillRoot {
  return { root, source: "user" };
}

describe("skill discovery", () => {
  test("discovers a valid skill and parses its frontmatter", async () => {
    const root = await makeRoot("valid");
    await writeSkill(root, "pdf-forms", "name: pdf-forms\ndescription: Fill PDF form fields.");

    const result = await discoverSkills([user(root)]);
    expect(result.skipped).toEqual([]);
    expect(result.skills).toHaveLength(1);
    const skill = result.skills[0]!;
    expect(skill.name).toBe("pdf-forms");
    expect(skill.slug).toBe("pdf-forms");
    expect(skill.frontmatter.description).toBe("Fill PDF form fields.");
    expect(skill.source).toBe("user");
    expect(skill.body).toContain("Body content");

    await rm(root, { recursive: true, force: true });
  });

  test("skips a skill whose name does not match its directory, naming the file", async () => {
    const root = await makeRoot("mismatch");
    const dir = await writeSkill(root, "pdf-forms", "name: not-the-dir\ndescription: A skill.");

    const result = await discoverSkills([user(root)]);
    expect(result.skills).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.path).toBe(join(dir, "SKILL.md"));
    expect(result.skipped[0]!.reason).toContain("name");

    await rm(root, { recursive: true, force: true });
  });

  test("skips an invalid name format", async () => {
    const root = await makeRoot("badname");
    await writeSkill(root, "Bad_Name", "name: Bad_Name\ndescription: Invalid name.");
    const result = await discoverSkills([user(root)]);
    expect(result.skills).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    await rm(root, { recursive: true, force: true });
  });

  test("skips a missing description", async () => {
    const root = await makeRoot("nodesc");
    await writeSkill(root, "no-desc", "name: no-desc");
    const result = await discoverSkills([user(root)]);
    expect(result.skills).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toContain("description");
    await rm(root, { recursive: true, force: true });
  });

  test("parses leniently when a description has an unquoted colon", async () => {
    const root = await makeRoot("lenient");
    await writeSkill(root, "colon", "name: colon\ndescription: Use this: when the model needs help.");
    const result = await discoverSkills([user(root)]);
    expect(result.skipped).toEqual([]);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.frontmatter.description).toBe("Use this: when the model needs help.");
    await rm(root, { recursive: true, force: true });
  });

  test("skips malformed YAML entirely", async () => {
    const root = await makeRoot("broken");
    await writeSkill(root, "broken", "name: [unterminated\ndescription: broken");
    const result = await discoverSkills([user(root)]);
    expect(result.skills).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    await rm(root, { recursive: true, force: true });
  });

  test("does not load project skills from an untrusted workspace", async () => {
    const root = await makeRoot("untrusted");
    await writeSkill(root, "proj", "name: proj\ndescription: Project skill.");
    const result = await discoverSkills([{ root, source: "project" }]);
    expect(result.skills).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toContain("trust");
    await rm(root, { recursive: true, force: true });
  });

  test("lists bundled resources without reading them", async () => {
    const root = await makeRoot("resources");
    const dir = await writeSkill(root, "with-assets", "name: with-assets\ndescription: Has assets.");
    await mkdir(join(dir, "scripts"), { recursive: true });
    await mkdir(join(dir, "references"), { recursive: true });
    await mkdir(join(dir, "assets"), { recursive: true });
    await writeFile(join(dir, "scripts", "run.sh"), "echo hi");
    await writeFile(join(dir, "references", "guide.md"), "# Guide");
    await writeFile(join(dir, "assets", "logo.png"), "png");

    const result = await discoverSkills([user(root)]);
    const skill = result.skills[0]!;
    const paths = skill.resources.map(r => r.path).sort();
    expect(paths).toEqual(["assets/logo.png", "references/guide.md", "scripts/run.sh"]);
    await rm(root, { recursive: true, force: true });
  });
});

describe("skill catalog", () => {
  test("lists only name and description — never the body", async () => {
    const root = await makeRoot("catalog");
    await writeSkill(root, "alpha", "name: alpha\ndescription: Alpha skill.", "SECRET BODY TEXT");
    const result = await discoverSkills([user(root)]);
    const catalog = buildSkillCatalog(result.skills);
    expect(catalog).toContain("alpha");
    expect(catalog).toContain("Alpha skill.");
    expect(catalog).not.toContain("SECRET BODY TEXT");
    await rm(root, { recursive: true, force: true });
  });
});

describe("skill collisions", () => {
  test("project before user: the loser is reported", async () => {
    const proj = await makeRoot("collide-project");
    const usr = await makeRoot("collide-user");
    await writeSkill(proj, "shared", "name: shared\ndescription: Project version.");
    await writeSkill(usr, "shared", "name: shared\ndescription: User version.");

    const result = await discoverSkills([project(proj), user(usr)]);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.source).toBe("project");
    expect(result.skills[0]!.frontmatter.description).toBe("Project version.");
    expect(result.collisions).toHaveLength(1);
    expect(result.collisions[0]!.name).toBe("shared");
    expect(result.collisions[0]!.winner).toBe("project");
    expect(result.collisions[0]!.loser).toBe("user");

    await rm(proj, { recursive: true, force: true });
    await rm(usr, { recursive: true, force: true });
  });

  test("precedence is order-independent (user root listed first)", async () => {
    const proj = await makeRoot("collide-project2");
    const usr = await makeRoot("collide-user2");
    await writeSkill(proj, "shared", "name: shared\ndescription: Project version.");
    await writeSkill(usr, "shared", "name: shared\ndescription: User version.");

    const result = await discoverSkills([user(usr), project(proj)]);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.source).toBe("project");
    expect(result.collisions).toHaveLength(1);

    await rm(proj, { recursive: true, force: true });
    await rm(usr, { recursive: true, force: true });
  });
});

describe("skill activation session", () => {
  test("activates a skill once, keeps the body, lists resources, survives compaction", async () => {
    const root = await makeRoot("activate");
    const dir = await writeSkill(root, "beta", "name: beta\ndescription: Beta skill.", "FULL BETA BODY");
    await mkdir(join(dir, "scripts"), { recursive: true });
    await writeFile(join(dir, "scripts", "run.sh"), "echo hi");

    const result = await discoverSkills([user(root)]);
    const session = new SkillSession(result.skills);

    const first = session.activate("beta");
    expect(first.activated).toBe(true);
    expect(first.skill?.body).toContain("FULL BETA BODY");

    // Deduplicated: activating again does not re-add.
    const second = session.activate("beta");
    expect(second.activated).toBe(false);
    expect(session.activatedNames).toEqual(["beta"]);

    // Body + resource listing are present in the rendered prompt section.
    const rendered = session.render();
    expect(rendered).toContain("FULL BETA BODY");
    expect(rendered).toContain("scripts/run.sh");

    // The rendered section is stable after a compaction (no re-read needed).
    expect(session.render()).toBe(rendered);

    await rm(root, { recursive: true, force: true });
  });

  test("activates a skill the user names in a message", async () => {
    const root = await makeRoot("bymention");
    await writeSkill(root, "gamma", "name: gamma\ndescription: Gamma skill.", "GAMMA BODY");
    const result = await discoverSkills([user(root)]);
    const session = new SkillSession(result.skills);

    const activated = session.activateFromMessage("please use the gamma skill for this");
    expect(activated.map(a => a.name)).toEqual(["gamma"]);
    expect(session.render()).toContain("GAMMA BODY");
    await rm(root, { recursive: true, force: true });
  });

  test("ignores activation of an unknown skill", async () => {
    const root = await makeRoot("unknown");
    await writeSkill(root, "delta", "name: delta\ndescription: Delta skill.");
    const result = await discoverSkills([user(root)]);
    const session = new SkillSession(result.skills);
    const attempt = session.activate("nope");
    expect(attempt.activated).toBe(false);
    expect(session.render()).toBe("");
    await rm(root, { recursive: true, force: true });
  });

  test("a clean profile loads only explicitly enabled skills", async () => {
    const root = await makeRoot("clean");
    await writeSkill(root, "keep", "name: keep\ndescription: Keep me.", "KEEP BODY");
    await writeSkill(root, "drop", "name: drop\ndescription: Drop me.", "DROP BODY");
    const result = await discoverSkills([user(root)]);
    const session = new SkillSession(result.skills, { enabled: ["keep"] });
    expect(session.catalog.map(s => s.name)).toEqual(["keep"]);
    expect(session.activate("drop").activated).toBe(false);
    expect(session.activate("keep").activated).toBe(true);
    await rm(root, { recursive: true, force: true });
  });
});

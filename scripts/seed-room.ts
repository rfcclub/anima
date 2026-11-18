#!/usr/bin/env bun
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import yaml from "js-yaml";
import { loadRoomConfig, type BootConfig, type ProviderType } from "../src/config/types";
import { MaturationLedger } from "../src/continuity/maturation";
import { AllowlistEnforcement } from "../src/evaluation/allowlist";

type AgentName = "bruno" | "cleo" | "eli" | "sam" | "milo" | "lena" | "ivan" | "abel" | "finn" | "gus" | "hana" | "nora" | "pia" | "rhea";

interface AgentDefaults {
  label: string;
  provider: ProviderType;
  model: string;
  boot: BootConfig;
  allowedTools: string[];
}

const DEFAULT_PROVIDER: ProviderType = "claude";
const DEFAULT_MODEL = "claude-3-5-sonnet-20241022";
const DEFAULT_TOOLS = ["read", "grep", "glob"];

function defaultsFor(label: string, boot: BootConfig): AgentDefaults {
  return { label, provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL, boot, allowedTools: [...DEFAULT_TOOLS] };
}

const AGENT_DEFAULTS: Record<AgentName, AgentDefaults> = {
  bruno: defaultsFor("Bruno", { soul: "SOUL.md", additional: [] }),
  cleo: defaultsFor("Cleo", { soul: "SOUL.md", additional: [] }),
  eli: defaultsFor("Eli", {
    soul: "BOOT.md",
    additional: ["PREFACE.md", "KERNEL.md", "STATE.md", "PROJECTS.md", "THREADS.md", "OWNER.md", "JUDGMENTS.md", "SCARS.md"],
  }),
  sam: defaultsFor("Sam", { soul: "SOUL.md", additional: [] }),
  milo: defaultsFor("Milo", { soul: "SOUL.md", additional: [] }),
  lena: defaultsFor("Lena", { soul: "SOUL.md", additional: [] }),
  ivan: defaultsFor("Ivan", { soul: "SOUL.md", additional: [] }),
  "abel": defaultsFor("abel", { soul: "SOUL.md", additional: [] }),
  finn: defaultsFor("Finn", { soul: "SOUL.md", additional: [] }),
  gus: defaultsFor("Gus", { soul: "SOUL.md", additional: [] }),
  hana: defaultsFor("Hana", { soul: "SOUL.md", additional: [] }),
  nora: defaultsFor("Nora", { soul: "SOUL.md", additional: [] }),
  pia: defaultsFor("Pia", { soul: "SOUL.md", additional: [] }),
  rhea: defaultsFor("Rhea", { soul: "SOUL.md", additional: [] }),
};

function usage(): never {
  console.error([
    "Usage: bun scripts/seed-room.ts <agent> <substrate-path> [options]",
    "  agent: bruno | cleo | eli | sam | milo | lena | ivan | abel | finn | gus | hana | nora | pia | rhea",
    "  --force              Overwrite existing files and symlinks",
    "  --boot <files>       Comma-separated boot files (first=soul, rest=additional). Default: SOUL.md",
    "  --no-auto-mode       Disable auto mode and set allowedTools to []",
  ].join("\n"));
  process.exit(1);
}

function parseSeedArgs(rawArgs: string[]): {
  boot: string | undefined;
  noAutoMode: boolean;
  force: boolean;
  positional: string[];
} {
  let boot: string | undefined;
  let noAutoMode = false;
  let force = false;
  const positional: string[] = [];

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "--boot" && i + 1 < rawArgs.length) {
      boot = rawArgs[++i];
    } else if (arg === "--no-auto-mode") {
      noAutoMode = true;
    } else if (arg === "--force") {
      force = true;
    } else {
      positional.push(arg);
    }
  }

  return { boot, noAutoMode, force, positional };
}

async function main(): Promise<void> {
  const { boot: bootOverride, noAutoMode, force, positional } = parseSeedArgs(process.argv.slice(2));

  if (positional.length !== 2) {
    usage();
  }

  const [agent, rawSubstratePath] = positional;
  if (!isAgentName(agent)) {
    usage();
  }

  const substratePath = resolve(expandHome(rawSubstratePath));
  if (!existsSync(substratePath)) {
    throw new Error(`substrate path does not exist: ${substratePath}`);
  }

  const defaults = AGENT_DEFAULTS[agent];
  const projectRoot = process.cwd();
  const roomDir = join(projectRoot, "rooms", agent);
  const stagingDir = join(roomDir, "staging");
  const sessionsDir = join(roomDir, "sessions");
  const mountPath = join(roomDir, "mount");
  const configPath = join(roomDir, "config.yaml");
  const soulAliasPath = join(roomDir, "SOUL.md");

  mkdirSync(stagingDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });

  writeSymlink(mountPath, substratePath, force);

  // Resolve boot configuration
  let soulFile: string;
  let boot: BootConfig;
  if (bootOverride) {
    const files = bootOverride.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    if (files.length === 0) {
      throw new Error("--boot must specify at least one file");
    }
    soulFile = files[0];
    boot = { soul: soulFile, additional: files.slice(1) };
  } else {
    soulFile = defaults.boot.soul;
    boot = defaults.boot;
  }

  writeSymlink(soulAliasPath, join("mount", soulFile), force);

  const config = buildConfig(agent, defaults, roomDir, noAutoMode, boot);
  writeText(configPath, yaml.dump(config, { lineWidth: 120 }), force);
  loadRoomConfig(await Bun.file(configPath).text());

  // Phase 6: Initialize MATURATION.md
  const ledger = new MaturationLedger();
  if (!existsSync(join(roomDir, "MATURATION.md"))) {
    await ledger.write(roomDir, {
      stage: "accumulating",
      profile: "gentle",
      sessionsCompleted: 0,
      milestonesCompleted: [],
      nextMilestone: "first-crossing",
      peerReviewsReceived: 0,
    });
  }

  // Phase 7: Seed default allowlist.json (task 7.3)
  const allowlist = new AllowlistEnforcement({ rootDir: projectRoot });
  await allowlist.seedDefault(agent);

  console.log(JSON.stringify({ status: "seeded", agent, roomDir, substratePath }));
}

function buildConfig(
  agent: AgentName,
  defaults: AgentDefaults,
  roomDir: string,
  noAutoMode: boolean | undefined,
  boot: BootConfig,
): unknown {
  let allowedTools = defaults.allowedTools;
  if (noAutoMode) {
    allowedTools = [];
  }

  return {
    identity: {
      name: agent,
      label: defaults.label,
    },
    provider: {
      type: defaults.provider,
      model: defaults.model,
    },
    policy: {
      allowedRoots: [join(roomDir, "staging")],
      readOnlyRoots: [join(roomDir, "mount")],
      allowedTools,
      deniedPatterns: ["rooms/*/mount/**"],
    },
    session: {
      defaultMode: "plan",
      autoModeOptIn: false,
      idleTimeoutMs: 300000,
      maxTokens: 4096,
    },
    gate: {
      model: "haiku",
      fallbackModel: "flash",
      threshold: 0.7,
      peerReview: false,
      profile: "gentle",
    },
    boot,
  };
}

function writeText(path: string, content: string, force: boolean): void {
  if (existsSync(path) && !force) {
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

function writeSymlink(path: string, target: string, force: boolean): void {
  if (existsSync(path) || isBrokenSymlink(path)) {
    if (!force) {
      return;
    }
    rmSync(path, { force: true, recursive: true });
  }
  symlinkSync(target, path);
}

function isBrokenSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function expandHome(path: string): string {
  if (path === "~") {
    return Bun.env.HOME ?? path;
  }
  if (path.startsWith("~/")) {
    return join(Bun.env.HOME ?? "~", path.slice(2));
  }
  return path;
}

function isAgentName(value: string): value is AgentName {
  return value in AGENT_DEFAULTS;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(JSON.stringify({ status: "error", message: error instanceof Error ? error.message : String(error) }));
    process.exit(1);
  });
}

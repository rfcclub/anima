import { afterEach, expect, test } from "bun:test";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProviderRegistry } from "../src/providers/registry";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureProvidersDir = join(here, "fixtures", "providers.d");
const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loads valid provider files from providers.d", async () => {
  const registry = await ProviderRegistry.load(fixtureProvidersDir);

  expect(registry.get("exampleprov")?.label).toBe("Nahcrof");
  expect(registry.list().map((provider) => provider.id)).toEqual(["exampleprov"]);

  const resolved = registry.resolve("kimi-k2p6@exampleprov");
  expect(resolved.provider.id).toBe("exampleprov");
  expect(resolved.model.id).toBe("kimi-k2p6");
});

test("skips invalid provider files with a warning", async () => {
  const root = await makeTempRoot();
  const providersDir = join(root, "providers.d");
  await mkdir(providersDir, { recursive: true });
  await copyFile(join(fixtureProvidersDir, "exampleprov.yaml"), join(providersDir, "valid.yaml"));
  await writeFile(join(providersDir, "invalid.yaml"), "id: broken\nlabel: Broken\napi: openai-completions\napiKey: nope\nmodels:\n  - id: broken-model\n");

  const warnings: string[] = [];
  const registry = await ProviderRegistry.load(providersDir, (message) => warnings.push(message));

  expect(registry.list().map((provider) => provider.id)).toEqual(["exampleprov"]);
  expect(warnings.some((warning) => warning.includes("invalid.yaml"))).toBe(true);
  expect(warnings.some((warning) => warning.includes("baseUrl"))).toBe(true);
});

test("returns an empty registry for an empty directory", async () => {
  const root = await makeTempRoot();
  const providersDir = join(root, "providers.d");
  await mkdir(providersDir, { recursive: true });

  const registry = await ProviderRegistry.load(providersDir);

  expect(registry.list()).toEqual([]);
});

test("merges OpenClaw imports from import.yaml", async () => {
  const root = await makeTempRoot();
  const providersDir = join(root, "providers.d");
  const openclawPath = join(root, "openclaw.json");
  await mkdir(providersDir, { recursive: true });
  await copyFile(join(fixtureProvidersDir, "exampleprov.yaml"), join(providersDir, "exampleprov.yaml"));
  await writeFile(join(root, "import.yaml"), `sources:\n  - type: openclaw\n    path: ${openclawPath}\n`);
  await writeFile(
    openclawPath,
    JSON.stringify({
      providers: {
        "fireworks-ai": {
          label: "Fireworks AI",
          baseUrl: "https://api.fireworks.ai/inference/v1",
          apiKey: "fw_test_key",
          models: [
            {
              id: "accounts/fireworks/models/llama-v3p1-70b-instruct",
              label: "Llama 3.1 70B",
            },
          ],
        },
      },
    }),
  );

  const registry = await ProviderRegistry.load(providersDir);

  expect(registry.get("exampleprov")).toBeDefined();
  expect(registry.get("fireworks-ai")?.api).toBe("openai-completions");
  expect(registry.resolve("accounts/fireworks/models/llama-v3p1-70b-instruct@fireworks-ai").model.label).toBe("Llama 3.1 70B");
});

test("warns and skips missing OpenClaw import files", async () => {
  const root = await makeTempRoot();
  const missingPath = join(root, "missing-openclaw.json");
  const warnings: string[] = [];

  const imported = await ProviderRegistry.importOpenClaw(missingPath, (message) => warnings.push(message));

  expect(imported).toEqual([]);
  expect(warnings.some((warning) => warning.includes("missing-openclaw.json"))).toBe(true);
});

async function makeTempRoot(): Promise<string> {
  const dir = await Bun.$`mktemp -d`.text();
  const root = dir.trim();
  tempDirs.push(root);
  return root;
}

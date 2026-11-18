import { readFileSync } from "node:fs";

/**
 * Loads only the named keys from a dotenv-style file into `env`.
 *
 * The service that runs identity-runtime carries no credentials (by design:
 * none in its service definition or in source), yet Bruno's recall classifier needs
 * TYPESAFE_API_KEY. The live keys sit in ~/.anima/anima.env; importing that
 * whole file would hand the runtime every provider secret it does not use, so
 * this takes an allow-list, never overrides a value already present, and returns
 * the NAMES it set (never values) so a startup log can say what was loaded.
 * Missing/unreadable files are not errors: the runtime then behaves as before.
 */
export function loadEnvKeys(
  file: string,
  allowed: readonly string[],
  env: Record<string, string | undefined> = process.env,
): string[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }

  const loaded: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, name, rawValue] = match;
    if (!allowed.includes(name) || env[name]) continue;
    const value = unquote(rawValue.trim());
    if (!value) continue;
    env[name] = value;
    loaded.push(name);
  }
  return loaded;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    if ((first === '"' || first === "'") && value.endsWith(first)) return value.slice(1, -1);
  }
  return value;
}

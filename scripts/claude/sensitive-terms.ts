import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The keyword list that tells "private" memories apart is NOT in this repository.
 * It is read from a local file so the repository itself carries no such content:
 *
 *   $ANIMA_SENSITIVE_TERMS_FILE, or ~/.anima/sensitive-terms.json
 *   { "phrases": ["<regex>", ...], "words": ["<regex>", ...] }
 *
 * `phrases` match anywhere; `words` match only as whole words (Unicode-aware, so it
 * works for accented scripts). Entries are regular-expression sources, case-insensitive.
 * See sensitive-terms.example.json for the shape.
 */
export interface SensitiveTerms {
  phrases: string[];
  words: string[];
}

export type SensitiveMatcher = (text: string) => boolean;

/** `ready` is false when no usable terms file exists: nothing can be classified then. */
export interface SensitiveGuard {
  ready: boolean;
  isSensitive: SensitiveMatcher;
}

export function termsFilePath(env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
  return env.ANIMA_SENSITIVE_TERMS_FILE || join(home, ".anima", "sensitive-terms.json");
}

const isTermList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((term) => typeof term === "string" && term.length > 0);

function compiles(source: string): boolean {
  try {
    new RegExp(source, "iu");
    return true;
  } catch {
    return false;
  }
}

/** Null when the file is missing or unusable (a broken list must not silently become "no list"). */
export function loadSensitiveTerms(
  options: { env?: Record<string, string | undefined>; home?: string; read?: (path: string) => string } = {},
): SensitiveTerms | null {
  const path = termsFilePath(options.env, options.home);
  const read = options.read ?? ((p: string) => readFileSync(p, "utf8"));
  let raw: unknown;
  try {
    raw = JSON.parse(read(path));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { phrases = [], words = [] } = raw as Record<string, unknown>;
  if (!isTermList(phrases) || !isTermList(words)) return null;
  if (![...phrases, ...words].every(compiles)) return null;
  return { phrases, words };
}

export function buildMatcher(terms: SensitiveTerms): SensitiveMatcher {
  const nfc = (list: string[]) => list.map((term) => term.normalize("NFC"));
  const phrase = terms.phrases.length ? new RegExp(nfc(terms.phrases).join("|"), "iu") : null;
  // JS `\b` is ASCII-only, hence the explicit Unicode letter/mark lookarounds.
  const word = terms.words.length
    ? new RegExp(`(?<![\\p{L}\\p{M}])(?:${nfc(terms.words).join("|")})(?![\\p{L}\\p{M}])`, "iu")
    : null;
  return (text) => {
    const normalized = text.normalize("NFC"); // composed and decomposed accents must match alike
    return (phrase?.test(normalized) ?? false) || (word?.test(normalized) ?? false);
  };
}

export function createGuard(terms: SensitiveTerms | null): SensitiveGuard {
  return terms ? { ready: true, isSensitive: buildMatcher(terms) } : { ready: false, isSensitive: () => false };
}

let cached: SensitiveGuard | undefined;

/** The guard built from the local file, loaded once per process. */
export function defaultSensitiveGuard(): SensitiveGuard {
  if (!cached) {
    cached = createGuard(loadSensitiveTerms());
    if (!cached.ready) {
      console.error(
        `[sensitive-guard] no usable terms file at ${termsFilePath()}: private-memory filtering is off, and nothing is sent to the relevance service`,
      );
    }
  }
  return cached;
}

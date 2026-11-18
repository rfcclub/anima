import type { ChangedFile } from "./publish-snapshot";
import { scanSecrets } from "./publish-secrets";

export type CheckName = "no-change" | "outside-repo" | "denied-path" | "too-large" | "secret-found";
export type CheckOutcome = { ok: true } | { ok: false; check: CheckName; detail: string };

const GENERATED_NAME = ".orca-verify.json";
const DEFAULT_MAX_LINES = 800;
const DEFAULT_MAX_FILES = 50;

/** True for a file the tools rewrite on every run, which is never judged or committed (`.orca-verify.json`, any depth). */
export function isGeneratedPath(path: string): boolean {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return path.slice(slash + 1) === GENERATED_NAME;
}

/** Split a change into the files that are judged and committed and the generated ones, preserving order and the input. */
export function partitionGenerated(files: ChangedFile[]): { kept: ChangedFile[]; generated: ChangedFile[] } {
  const kept: ChangedFile[] = [];
  const generated: ChangedFile[] = [];
  for (const file of files) (isGeneratedPath(file.path) ? generated : kept).push(file);
  return { kept, generated };
}

/**
 * Absolute on any platform the host may run on: a POSIX path, a Windows drive path (`C:/x`, `C:\\x`, and
 * drive-relative `C:x`), a root-relative `\\x` or a UNC/device path (`\\\\server\\share`).
 */
function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path);
}

/**
 * Resolve `.`, `..` and empty segments below `base`. Returns `undefined` when the path is absolute or when a `..`
 * climbs above the repository root. Windows separators count as separators, so a `..\\..` cannot step outside.
 */
function normaliseFrom(base: string[], path: string): string | undefined {
  if (isAbsolutePath(path)) return undefined;
  const segments = [...base];
  for (const segment of path.split(/[\\/]/)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return undefined;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

/**
 * Check that a changed path, and its symlink target, stay inside the tree. Returns the normalised changed path and
 * target (which the deny list needs) or `undefined` when either escapes or names nothing (an empty path, `.`).
 * A relative symlink target is resolved from the link's parent directory, as the file system does.
 */
function confine(path: string, symlinkTarget?: string): { path: string; target?: string } | undefined {
  if (path.includes("\0")) return undefined;
  const normalised = normaliseFrom([], path);
  if (normalised === undefined || normalised === "") return undefined;
  if (symlinkTarget === undefined) return { path: normalised };
  if (symlinkTarget.includes("\0")) return undefined;
  const parent = normalised.split("/").slice(0, -1);
  const target = normaliseFrom(parent, symlinkTarget);
  return target === undefined || target === "" ? undefined : { path: normalised, target };
}

const DENIED_FILE_NAMES = [/^\.env$/, /^\.env\./, /^\.envrc$/, /\.pem$/, /\.key$/];
const DENIED_SEGMENTS = new Set(["secrets", ".git", "node_modules"]);

/** Deny rules run on the normalised path, so an internal `..` cannot smuggle a denied path past them. */
function deniedPath(normalised: string): boolean {
  const segments = normalised.split("/");
  const name = segments[segments.length - 1]!;
  const directories = segments.slice(0, -1);
  if (segments[0] === ".github" && segments[1] === "workflows" && segments.length > 2) return true;
  if (normalised === ".git") return true;
  if (DENIED_FILE_NAMES.some((pattern) => pattern.test(name))) return true;
  return directories.some((segment) => DENIED_SEGMENTS.has(segment));
}

/**
 * Judge the change a host would commit: the caller filters generated files first, so this runs on exactly the list
 * that would be committed. Checks run in spec order and the first failure is returned; `detail` names a path and
 * never holds file contents or a matched secret.
 */
export function checkChange(
  files: ChangedFile[],
  readText: (path: string) => string | undefined,
  limits: { maxLines?: number; maxFiles?: number } = {},
): CheckOutcome {
  const maxLines = limits.maxLines ?? DEFAULT_MAX_LINES;
  const maxFiles = limits.maxFiles ?? DEFAULT_MAX_FILES;

  if (files.length === 0) return { ok: false, check: "no-change", detail: "the change is empty" };

  for (const file of files) {
    const confined = confine(file.path, file.symlinkTarget);
    if (confined === undefined) {
      return { ok: false, check: "outside-repo", detail: `path escapes the tree: ${file.path}` };
    }
    if (deniedPath(confined.path)) {
      return { ok: false, check: "denied-path", detail: `path is denied by policy: ${file.path}` };
    }
    if (confined.target !== undefined && deniedPath(confined.target)) {
      return { ok: false, check: "denied-path", detail: `symlink target is denied by policy: ${file.path}` };
    }
  }

  const lines = files.reduce((total, file) => total + file.added + file.deleted, 0);
  const binary = files.find((file) => file.binary);
  if (binary) return { ok: false, check: "too-large", detail: `binary file is not published: ${binary.path}` };
  if (files.length > maxFiles) {
    return { ok: false, check: "too-large", detail: `${files.length} files is more than ${maxFiles}` };
  }
  if (lines > maxLines) {
    return { ok: false, check: "too-large", detail: `${lines} changed lines is more than ${maxLines}` };
  }

  for (const file of files) {
    if (file.isDeleted) continue;
    const text = readText(file.path);
    if (text === undefined) {
      return { ok: false, check: "secret-found", detail: `file could not be read: ${file.path}` };
    }
    if (scanSecrets(text) !== null) {
      return { ok: false, check: "secret-found", detail: `file holds a secret: ${file.path}` };
    }
  }

  return { ok: true };
}

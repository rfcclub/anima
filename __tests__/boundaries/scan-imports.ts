/**
 * Static import-statement scanner — no bundler dependency, plain regex over
 * source text. Used by world-boundary.test.ts to enforce the preventive
 * import walls between layers.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, dirname, resolve } from "node:path";
import ts from "typescript";

export interface ImportViolation {
  file: string;
  line: number;
  statement: string;
  matched: string;
}

const IMPORT_RE = /^\s*import\s[^;]*?from\s*["']([^"']+)["']/gm;
const REQUIRE_RE = /require\(\s*["']([^"']+)["']\s*\)/g;

/** All .ts/.tsx source files under dir, excluding *.test.ts and node_modules. */
export function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if ((extname(entry) === ".ts" || extname(entry) === ".tsx") && !entry.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

function extractImportPaths(source: string): Array<{ line: number; statement: string; path: string }> {
  const results: Array<{ line: number; statement: string; path: string }> = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    const path = match[1];
    const line = source.slice(0, match.index ?? 0).split("\n").length;
    results.push({ line, statement: match[0], path });
  }
  for (const match of source.matchAll(REQUIRE_RE)) {
    const path = match[1];
    const line = source.slice(0, match.index ?? 0).split("\n").length;
    results.push({ line, statement: match[0], path });
  }
  return results;
}

/**
 * Scan every source file under `dir` and flag any import whose resolved path
 * (relative import path, not disk-resolved) matches one of `forbiddenSubstrings`.
 */
export function findForbiddenImports(
  dir: string,
  forbiddenSubstrings: string[],
): ImportViolation[] {
  const violations: ImportViolation[] = [];
  for (const file of listSourceFiles(dir)) {
    const source = readFileSync(file, "utf-8");
    for (const { line, statement, path } of extractImportPaths(source)) {
      const matched = forbiddenSubstrings.find((s) => path.includes(s));
      if (matched) {
        violations.push({ file, line, statement, matched });
      }
    }
  }
  return violations;
}

/** Scan a raw source string (for fixture-based negative tests, no file needed). */
export function findForbiddenImportsInSource(
  source: string,
  fileLabel: string,
  forbiddenSubstrings: string[],
): ImportViolation[] {
  const violations: ImportViolation[] = [];
  for (const { line, statement, path } of extractImportPaths(source)) {
    const matched = forbiddenSubstrings.find((s) => path.includes(s));
    if (matched) {
      violations.push({ file: fileLabel, line, statement, matched });
    }
  }
  return violations;
}

export interface ResolvedImport {
  line: number;
  specifier: string;
  /** Absolute path the relative specifier points at (not disk-checked, extension untouched). */
  resolved: string;
}

/**
 * Relative module specifiers of `source` (a file at `filePath`), resolved to absolute paths so
 * callers can check directory containment instead of matching substrings. Uses the TypeScript
 * parser, so comments, strings and whitespace cannot hide or fake a dependency. Covers
 * `import`/`export ... from`, side-effect `import "x"`, `import x = require("x")`, literal
 * `import("x")` and `require("x")`. Bare specifiers are ignored. Non-literal `import(expr)`
 * cannot be resolved statically.
 */
export function extractResolvedImports(source: string, filePath: string): ResolvedImport[] {
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: ResolvedImport[] = [];
  const add = (literal: ts.Node | undefined, statement: ts.Node) => {
    if (!literal || !ts.isStringLiteralLike(literal)) return;
    const specifier = literal.text;
    if (!specifier.startsWith(".")) return;
    const line = sf.getLineAndCharacterOfPosition(statement.getStart(sf)).line + 1;
    out.push({ line, specifier, resolved: resolve(dirname(filePath), specifier) });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier, node);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression, node);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      if ((isDynamicImport || isRequire) && node.arguments.length >= 1) add(node.arguments[0], node);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out.sort((a, b) => a.line - b.line);
}

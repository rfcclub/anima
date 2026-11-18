import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { extractResolvedImports, listSourceFiles } from "./scan-imports";

const ROOT = join(import.meta.dir, "..", "..");

// Direction:
//   packages/identity-runtime  ->  src/identity-runtime/contract, src/memory, src/providers
//   src/identity-runtime       ->  never packages/identity-runtime
const ALLOWED_SRC_FROM_PACKAGE = [
  join("src", "memory"),
  join("src", "providers"),
  join("src", "identity-runtime", "contract"),
];
const PACKAGE_DIR = join("packages", "identity-runtime");

function within(rel: string, dir: string): boolean {
  return rel === dir || rel.startsWith(dir + sep);
}

/** Imports in a src/identity-runtime file that resolve into the service package. */
export function upwardViolations(source: string, file: string) {
  return extractResolvedImports(source, file).filter((i) => within(relative(ROOT, i.resolved), PACKAGE_DIR));
}

/** Imports in a package file that resolve into src/ outside the allowed modules. */
export function downwardViolations(source: string, file: string) {
  return extractResolvedImports(source, file).filter((i) => {
    const rel = relative(ROOT, i.resolved);
    return within(rel, "src") && !ALLOWED_SRC_FROM_PACKAGE.some((d) => within(rel, d));
  });
}

const inSrc = join(ROOT, "src", "identity-runtime", "x.ts");
const inPkg = join(ROOT, "packages", "identity-runtime", "src", "x.ts");
const label = (v: { line: number }[]) => v.map((x) => x.line);

describe("identity-runtime dependency direction", () => {
  test("src/identity-runtime never imports packages/identity-runtime", () => {
    const offending = listSourceFiles(join(ROOT, "src", "identity-runtime")).flatMap((file) =>
      upwardViolations(readFileSync(file, "utf-8"), file).map((v) => `${relative(ROOT, file)}:${v.line}`),
    );
    expect(offending).toEqual([]);
  });

  test("packages/identity-runtime reaches into src/ only through allowed modules", () => {
    const offending = listSourceFiles(join(ROOT, "packages", "identity-runtime", "src")).flatMap((file) =>
      downwardViolations(readFileSync(file, "utf-8"), file).map((v) => `${relative(ROOT, file)}:${v.line}`),
    );
    expect(offending).toEqual([]);
  });

  describe("every dependency form is detected with its line", () => {
    const target = "../../packages/identity-runtime/src/runtime.ts";
    const forms: Record<string, string> = {
      "named import": `import { A } from "${target}";`,
      "type import": `import type { A } from "${target}";`,
      "side-effect import": `import "${target}";`,
      "re-export": `export { A } from "${target}";`,
      "star re-export": `export * from "${target}";`,
      "multi-line import": `import {\n  A,\n  B,\n} from "${target}";`,
      "literal dynamic import": `const m = await import("${target}");`,
      "require": `const m = require("${target}");`,
      "dynamic import with a space": `const m = await import ("${target}");`,
      "dynamic import split across lines": `const m = await import(\n  "${target}"\n);`,
      "comment with an apostrophe inside the braces": `import { A /* don't inline the service */ } from "${target}";`,
      "line comment with an apostrophe": `import {\n  A, // it's the service\n} from "${target}";`,
      "import type node": `type T = import("${target}").A;`,
      "import-equals require": `import m = require("${target}");`,
    };
    for (const [name, code] of Object.entries(forms)) {
      test(name, () => {
        const found = upwardViolations(`// header\n${code}\n`, inSrc);
        expect(label(found)).toEqual([2]);
      });
    }
  });

  describe("text that only looks like an import is ignored", () => {
    test("a specifier inside a comment or string", () => {
      const code = [
        `// import { A } from "../../packages/identity-runtime/src/runtime.ts";`,
        `/* export * from "../../packages/identity-runtime/src/runtime.ts"; */`,
        'const s = \'import x from "../../packages/identity-runtime/src/runtime.ts"\';',
      ].join("\n");
      expect(upwardViolations(code, inSrc)).toEqual([]);
    });
  });

  describe("allowlist applies to the resolved target", () => {
    test("a traversal out of an allowed directory is rejected", () => {
      const code = `import { L } from "../../../src/identity-runtime/contract/../../agents/loader.ts";`;
      expect(label(downwardViolations(code, inPkg))).toEqual([1]);
    });
    test("allowed targets pass", () => {
      const code = [
        `import type { M } from "../../../src/memory/contract.ts";`,
        `import { P } from "../../../src/providers/router.ts";`,
        `import type { S } from "../../../src/identity-runtime/contract/scope-mapper.ts";`,
        `import { C } from "../../continuity-core/src/index.js";`,
      ].join("\n");
      expect(downwardViolations(code, inPkg)).toEqual([]);
    });
    test("an unrelated src/ target is rejected", () => {
      expect(label(downwardViolations(`import { x } from "../../../src/agents/loader.ts";`, inPkg))).toEqual([1]);
    });
  });
});

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, extname, resolve, sep } from "node:path";
import { UI_DIR } from "../services/session-store";

const STATIC_URL_REWRITES: Array<[prefix: string, physicalDir: string]> = [
  ["/components/", join(UI_DIR, "features", "town", "components") + "/"],
  ["/vn/engines/", join(UI_DIR, "engines", "vn-vanilla") + "/"],
  ["/assets/", join(UI_DIR, "assets") + "/"],
];

/** Derive MIME type from a file extension. */
export function mimeType(ext: string): string {
  switch (ext) {
    case ".html": return "text/html; charset=utf-8";
    case ".css":  return "text/css; charset=utf-8";
    case ".js":   return "application/javascript; charset=utf-8";
    case ".tsx":
    case ".ts":   return "application/javascript; charset=utf-8";
    case ".json": return "application/json";
    case ".svg":  return "image/svg+xml";
    case ".png":  return "image/png";
    case ".ico":  return "image/x-icon";
    default:      return "application/octet-stream";
  }
}

/** Transpile a .tsx/.ts file to JavaScript for the browser. */
export function transpile(source: string, path: string): string {
  // Use Bun's built-in transpiler to convert TSX → JS
  const ext = extname(path);
  const loader = ext === ".tsx" ? "tsx" : "ts";
  const transpiler = new Bun.Transpiler({ loader });
  return transpiler.transformSync(source);
}

export function serveStatic(uiDir: string, urlPath: string): Response | null {
  // Built SPA bundle assets (hashed <name>-<hash>.js / .css, e.g. index-*,
  // chunk-*, or a lazy-loaded page's own name) live in dist/. Regex allows
  // only alphanumeric/underscore chunk names and alphanumeric/underscore/dash
  // hashes (Bun's naming format); containment check is defense-in-depth
  // against any traversal that slips the regex.
  if (/^\/[a-zA-Z0-9_]+-[a-zA-Z0-9_-]+\.(js|css)$/.test(urlPath)) {
    const assetPath = join(uiDir, "dist", urlPath.replace(/^\//, ""));
    const resolved = resolve(assetPath);
    const distDir = resolve(join(uiDir, "dist"));
    if (!resolved.startsWith(distDir + sep)) {
      return null;
    }
    if (existsSync(assetPath)) {
      const ext = extname(assetPath);
      return new Response(readFileSync(assetPath), {
        headers: { "content-type": mimeType(ext) },
      });
    }
  }

  // Prefix rewrites first (whole directories that moved, e.g. /components/*, /vn/engines/*).
  for (const [prefix, physicalDir] of STATIC_URL_REWRITES) {
    if (urlPath.startsWith(prefix)) {
      const rest = urlPath.slice(prefix.length);
      const filePath = join(physicalDir, rest);
      const resolved = resolve(filePath);
      const base = resolve(physicalDir);
      if ((resolved === base || resolved.startsWith(base + "/")) && existsSync(resolved)) {
        const ext = extname(resolved);
        if (ext === ".tsx" || ext === ".ts") {
          const source = readFileSync(resolved, "utf-8");
          const code = transpile(source, resolved);
          return new Response(code, { headers: { "content-type": "application/javascript; charset=utf-8" } });
        }
        const content = readFileSync(resolved);
        return new Response(content, { headers: { "content-type": mimeType(ext) } });
      }
      // not found at new location yet — fall through to legacy flat-dir lookup below
      break;
    }
  }

  // Fallback: original flat-directory behavior for anything not rewritten above,
  // or not yet physically relocated (see fallthrough notes above)
  // For the root index.html, prefer the built bundle (dist/index.html) if present.
  let relativePath = urlPath === "/" ? "index.html" : urlPath.replace(/^\//, "");
  let filePath = join(uiDir, relativePath);
  if (relativePath === "index.html") {
    const built = join(uiDir, "dist", "index.html");
    if (existsSync(built)) filePath = built;
  }

  // Security: prevent directory traversal
  const resolved = resolve(filePath);
  if (!resolved.startsWith(resolve(uiDir) + "/") && resolved !== resolve(uiDir)) {
    return null;
  }

  if (!existsSync(resolved)) return null;
  if (statSync(resolved).isDirectory()) return null;

  const ext = extname(resolved);

  // Transpile .tsx/.ts files on the fly
  if (ext === ".tsx" || ext === ".ts") {
    const source = readFileSync(resolved, "utf-8");
    const code = transpile(source, resolved);
    return new Response(code, {
      headers: { "content-type": "application/javascript; charset=utf-8" },
    });
  }

  // Serve static files
  const content = readFileSync(resolved);
  return new Response(content, {
    headers: { "content-type": mimeType(ext) },
  });
}

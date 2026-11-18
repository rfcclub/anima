import { existsSync } from "node:fs";
import { join } from "node:path";
import { handleUIRequest } from "./router";
import { guardConfig, type GuardConfig } from "./origin-guard";
import { json } from "../utils/http";
import { UI_DIR } from "../services/session-store";
import type { UIServerDeps } from "../types";

export function startUIServer(deps?: UIServerDeps): ReturnType<typeof Bun.serve> {
  const port = Number(Bun.env.ANIMA_UI_PORT ?? 3000);

  // Built on the first request, once the bound port is known.
  let guard: GuardConfig | undefined;
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port,
    // Loopback unless ANIMA_UI_HOST opts in to more.
    hostname: Bun.env.ANIMA_UI_HOST ?? "127.0.0.1",
    // Bun's default idleTimeout is 10s. Agent replies stream over SSE and can
    // legitimately go quiet for longer than that between tool calls / while
    // waiting on a slow provider — the default kills the connection mid-reply
    // and the client shows "Connection error". 255 is Bun's max — bounded so
    // a stalled/abusive connection still gets reclaimed instead of held forever.
    idleTimeout: 255,
    // Most request bodies here are small JSON payloads (chat/meeting messages,
    // config edits), but vn-assets uploads are multipart file bodies up to
    // 10MB (see MAX_SIZE in features/vn-assets/api/assets.ts) — cap must clear
    // that plus multipart overhead, well below Bun's 128MB default.
    maxRequestBodySize: 12 * 1024 * 1024,
    async fetch(req): Promise<Response> {
      try {
        return await handleUIRequest(req, { ...deps, guard: (guard ??= guardConfig(server.port ?? port, Bun.env)) });
      } catch (error) {
        console.error("unhandled UI server error:", error);
        return json({ error: "internal_server_error" }, 500);
      }
    },
  });

  console.log(`Agent Town UI started on http://${server.hostname}:${server.port}`);
  return server;
}

export async function buildClientBundle(uiDir: string = UI_DIR): Promise<void> {
  const entry = join(uiDir, "index.html");

  if (!existsSync(entry)) {
    console.warn("SPA entry not found, skipping bundle build");
    return;
  }

  // Boot-build skip: in prod, deploy.sh already built the bundle into
  // uiDir/dist/ (CWD=repo, so the ui/→src/ relative imports resolve). The
  // server runs from ~/.anima/ where ui/ is rsync'd but its sibling source
  // dirs (narrative/, agents/, session/, ...) are NOT — so a boot-time
  // Bun.build here can never resolve those imports and always fails,
  // logging "ui bundle build failed" every boot while the deploy.sh-built
  // dist keeps serving fine. Skip when a bundle already exists; only build
  // when dist/index.html is missing (dev cold-start).
  const builtIndex = join(uiDir, "dist", "index.html");
  if (existsSync(builtIndex)) {
    return;
  }

  const result = await Bun.build({
    entrypoints: [entry],
    outdir: join(uiDir, "dist"),
    target: "browser",
    format: "esm",
    sourcemap: "inline",
    // Entry (index.html) keeps a stable name — the SPA fallback in router.ts
    // looks for dist/index.html literally. Chunks/assets stay hashed for
    // cache-busting; serveStatic() matches any hashed JS/CSS at the dist root.
    naming: {
      entry: "[name].[ext]",
      chunk: "[name]-[hash].[ext]",
      asset: "[name]-[hash].[ext]",
    },
    // Without this, the bundler emits relative asset URLs ("./index-*.js"),
    // which resolve against the CURRENT route (e.g. /rooms/cleo serves the
    // SPA shell but the browser then requests /rooms/index-*.js and 404s —
    // silently, since the SPA fallback returns index.html for that too, so
    // it comes back 200 with the wrong content-type and never executes).
    // Every non-root route is broken without this.
    publicPath: "/",
    // Bun's CSS bundler does not understand Tailwind v4's @theme/@tailwind
    // at-rules on its own — without this plugin it just inlines the raw
    // preprocessor source (theme tokens, no generated utility classes), so
    // every Tailwind class in the app silently does nothing.
    plugins: [(await import("bun-plugin-tailwind")).default],
  });

  if (!result.success) {
    console.error("Client bundle build failed:", result.logs);
  } else {
    console.log("Client bundle built successfully");
  }
}

if (import.meta.main) {
  buildClientBundle().then(() => startUIServer()).catch(console.error);
}

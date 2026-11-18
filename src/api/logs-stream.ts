import { existsSync, statSync } from "node:fs";

export function createLogStream(req: Request, filePath: string): Response {
  let lastSize = existsSync(filePath) ? statSync(filePath).size : 0;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const enc = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      const poll = async () => {
        if (closed) return;
        if (!existsSync(filePath)) return;
        let size: number;
        try { size = statSync(filePath).size; } catch { return; }
        if (size <= lastSize) return;
        try {
          const text = await Bun.file(filePath).slice(lastSize, size).text();
          lastSize = size;
          for (const line of text.split("\n")) {
            if (!line.trim()) continue;
            try {
              JSON.parse(line);
              controller.enqueue(enc.encode(`data: ${line}\n\n`));
            } catch { /* skip malformed */ }
          }
        } catch { /* file read error — non-fatal */ }
      };

      intervalId = setInterval(poll, 500);

      req.signal.addEventListener("abort", () => {
        closed = true;
        if (intervalId !== null) { clearInterval(intervalId); intervalId = null; }
        try { controller.close(); } catch {}
      });
    },
    cancel() {
      closed = true;
      if (intervalId !== null) { clearInterval(intervalId); intervalId = null; }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

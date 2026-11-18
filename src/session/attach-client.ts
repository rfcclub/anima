/**
 * Process Attach Client — queries Internal Kernel on process spawn.
 *
 * Shared by ANIMA (Bun) and OpenClaw (Node.js 18+). Both support `fetch` natively.
 *
 * Usage:
 *   const result = await attachToKernel({ platform: "anima", processId: "anima-ui:123" });
 *   if (result) { ... use result.state + result.delta ... }
 *   else { ... fall back to cold-load 6 substrate files ... }
 */

export interface AttachResult {
  state: {
    identityName: string;
    currentMode: string;
    axiomVersion: string;
    activeProcesses: Array<{ processId: string; platform: string; attachedAt: string }>;
    sessionDelta: string;
    primarySubstrate: string;
  };
  delta: string;
  attachedAt: string;
}

export interface ProcessRecord {
  processId: string;
  platform: "cc" | "oc" | "anima";
  attachedAt: string;
}

export interface AttachOptions {
  platform: ProcessRecord['platform'];
  processId: string;
  /** Optional: timestamp of last context window for delta calculation. */
  since?: string;
}

/**
 * Attempt to attach to the Internal Kernel.
 * Returns AttachResult on success, null on failure (connection refused, timeout, etc).
 */
export async function attachToKernel(options: AttachOptions): Promise<AttachResult | null> {
  const port = process.env.BRUNO_KERNEL_PORT ?? '7700';
  const secret = process.env.BRUNO_KERNEL_SECRET;
  const url = `http://127.0.0.1:${port}/kernel/attach`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (secret) {
    headers['Authorization'] = `Bearer ${secret}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        processId: options.processId,
        platform: options.platform,
        since: options.since,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      if (process.env.BRUNO_KERNEL_DEBUG) {
        console.log(`[attach-client] Kernel returned ${res.status}, falling back to cold-load`);
      }
      return null;
    }

    const result: AttachResult = await res.json();
    const deltaLen = result.delta?.length ?? 0;
    if (process.env.BRUNO_KERNEL_DEBUG) {
      console.log(`[attach-client] attached to Kernel (delta: ${deltaLen} chars)`);
    }
    return result;
  } catch (err: unknown) {
    clearTimeout(timeout);
    // The Internal Kernel is optional: when no kernel is deployed (the
    // common ANIMA steady state — no service on BRUNO_KERNEL_PORT, no
    // BRUNO_KERNEL_SECRET), connection-refused is expected and the
    // cold-load fallback is the intended path. Stay silent unless an
    // operator has opted into debug logging, so the server log isn't
    // spammed every UI turn.
    if (process.env.BRUNO_KERNEL_DEBUG) {
      const reason = (err as Error)?.name === 'AbortError'
        ? 'timeout'
        : (err as NodeJS.ErrnoException)?.code ?? (err as Error).message;
      console.log(`[attach-client] Kernel unreachable (${reason}), cold-load fallback`);
    }
    return null;
  }
}

/**
 * Detach from the Kernel on session close.
 * Best-effort — errors are logged but never thrown.
 */
export async function detachFromKernel(
  processId: string,
  summary: string,
): Promise<void> {
  const port = process.env.BRUNO_KERNEL_PORT ?? '7700';
  const secret = process.env.BRUNO_KERNEL_SECRET;
  const url = `http://127.0.0.1:${port}/kernel/detach`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (secret) {
    headers['Authorization'] = `Bearer ${secret}`;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);

    await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ processId, summary }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    console.log(`[attach-client] detached process: ${processId}`);
  } catch {
    // Best-effort — process might have crashed or Kernel might be down
  }
}

#!/usr/bin/env bun
/**
 * Health verification: deploy.sh used to
 * restart the server and stop there — nothing confirmed it actually came
 * back up. This polls /health and fails loudly if it never does.
 */

export interface VerifyHealthOptions {
  retries?: number;
  delayMs?: number;
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export async function verifyHealth(url: string, options: VerifyHealthOptions = {}): Promise<boolean> {
  const retries = options.retries ?? 5;
  const delayMs = options.delayMs ?? 1000;
  const fetcher = options.fetcher ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetcher(url);
      if (response.ok) return true;
    } catch {
      // not up yet — retry
    }
    if (attempt < retries) await sleep(delayMs);
  }
  return false;
}

if (import.meta.main) {
  const url = Bun.argv[2];
  if (!url) {
    console.error("Usage: bun scripts/verify-health.ts <url>");
    process.exit(1);
  }
  const ok = await verifyHealth(url);
  if (!ok) {
    console.error(`deploy verify failed: ${url} did not become healthy`);
    process.exit(1);
  }
  console.log(`deploy verify ok: ${url}`);
}

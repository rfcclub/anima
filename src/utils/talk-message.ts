/**
 * `anima talk -m -` reads the message from stdin. A queued review prompt can
 * exceed Linux's 128 KiB per-argument limit (E2BIG), so callers that spawn the
 * CLI pass it this way.
 */
export async function resolveTalkMessage(flag: string, readStdin: () => Promise<string> = () => Bun.stdin.text()): Promise<string> {
  return flag === "-" ? readStdin() : flag;
}

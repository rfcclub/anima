const TRAVERSAL_RE = /[\/\\]|\.\./;

/** Reject agentId containing path separators or traversal. */
export function guardAgentId(agentId: string): void {
  if (!agentId || TRAVERSAL_RE.test(agentId)) {
    throw new Error(`invalid agentId: ${agentId}`);
  }
}

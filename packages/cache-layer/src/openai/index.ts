export function buildCacheKeyHeader(
  agentId: string | undefined
): Record<string, string> {
  if (!agentId) return {};
  return { prompt_cache_key: agentId };
}

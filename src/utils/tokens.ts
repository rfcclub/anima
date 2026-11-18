/**
 * Rough token estimate: characters / 4, rounded up.
 * Used for budget checks, truncation, and prompt sizing throughout the substrate.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Token estimation utilities.
// Character-based heuristic: ~4 characters per token for English text.
// Falls back to a simple ratio for CJK/mixed content.

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string | null): number {
  if (!text) return 0;
  // Count CJK characters (higher token density) vs ASCII
  let cjk = 0;
  let ascii = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x4E00 && code <= 0x9FFF) cjk++;
    else if (code >= 0x3000 && code <= 0x303F) cjk++; // CJK punctuation
    else if (code > 127) cjk++;
    else ascii++;
  }
  // CJK: ~1.5 chars per token, ASCII: ~4 chars per token
  return Math.max(1, Math.ceil(cjk / 1.5 + ascii / CHARS_PER_TOKEN));
}

export function truncateTextToEstimatedTokens(text: string, maxTokens: number): string {
  if (!text || maxTokens <= 0) return '';
  const estimated = estimateTokens(text);
  if (estimated <= maxTokens) return text;

  // Binary search for cutoff point
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (estimateTokens(text.slice(0, mid)) <= maxTokens) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return text.slice(0, lo) + '\n[truncated]';
}

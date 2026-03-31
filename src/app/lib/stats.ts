/**
 * Content statistics — word count, character count, estimated read time.
 *
 * Pure functions, no side effects. Used as a $derived dependency in App.svelte
 * so stats update reactively on every keystroke.
 */

export interface ContentStats {
  words: number;
  chars: number;
  readTime: number; // minutes, rounded up (0 for empty content)
}

/**
 * Compute content statistics from a markdown string.
 *
 * - Words: split on whitespace, filter empties
 * - Chars: string length (including markdown syntax)
 * - Read time: words / 200 WPM, rounded up (minimum 1 for non-empty, 0 for empty)
 */
export function computeStats(content: string): ContentStats {
  const trimmed = content.trim();
  const words = trimmed === '' ? 0 : trimmed.split(/\s+/).filter(Boolean).length;
  const chars = content.length;
  const readTime = words === 0 ? 0 : Math.ceil(words / 200);

  return { words, chars, readTime };
}

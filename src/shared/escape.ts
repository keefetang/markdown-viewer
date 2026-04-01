/**
 * Isomorphic HTML escape utilities.
 *
 * Safe to use in both browser (Svelte SPA) and server (Cloudflare Worker)
 * contexts. Two functions cover the two common escaping needs:
 *
 * - `escapeForHtml` — full attribute + text node escape (& " ' < >)
 * - `escapeText` — text node only escape (& < >), safe where quotes are harmless
 */

// ---------------------------------------------------------------------------
// Full HTML escape (attributes + text nodes)
// ---------------------------------------------------------------------------

const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '"': '&quot;',
  "'": '&#39;',
  '<': '&lt;',
  '>': '&gt;',
};

/**
 * Escape a string for safe embedding in HTML attributes **and** text nodes.
 *
 * Covers all five HTML-special characters: `& " ' < >`.
 * Use this when the value may appear in an attribute (`href="…"`, `content="…"`)
 * or anywhere quotes could break out of a delimited context.
 *
 * @param value - Raw string to escape.
 * @returns HTML-safe string.
 */
export function escapeForHtml(value: string): string {
  return value.replace(/[&"'<>]/g, (ch) => HTML_ESCAPE_MAP[ch] || ch);
}

// ---------------------------------------------------------------------------
// Text-node-only escape
// ---------------------------------------------------------------------------

/**
 * Escape a string for safe embedding in HTML **text nodes only**.
 *
 * Covers `& < >` — the characters that are dangerous in text content.
 * Quotes (`"`, `'`) are intentionally **not** escaped because they are
 * harmless inside text nodes and escaping them would add unnecessary noise
 * (e.g. in `<pre>` blocks or `<title>` content).
 *
 * Do **not** use this for attribute values — use {@link escapeForHtml} instead.
 *
 * @param value - Raw string to escape.
 * @returns Text-node-safe string.
 */
export function escapeText(value: string): string {
  return value.replace(/[&<>]/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      default: return ch;
    }
  });
}

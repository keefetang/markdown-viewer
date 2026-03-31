/**
 * Shared types and utilities for the Worker layer.
 *
 * Pure types and functions only — no Cloudflare bindings, no side effects.
 * Each Worker file declares its own narrowed `Env` interface (principle of
 * least privilege); this module holds the common bits.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionMetadata {
  createdAt: number;
  updatedAt: number;
  editToken: string;
}

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '"': '&quot;',
  "'": '&#39;',
  '<': '&lt;',
  '>': '&gt;',
};

/** Escape a string for safe embedding in HTML attributes, text nodes, or JS string literals. */
export function escapeForHtml(value: string): string {
  return value.replace(/[&"'<>]/g, (ch) => HTML_ESCAPE_MAP[ch] || ch);
}

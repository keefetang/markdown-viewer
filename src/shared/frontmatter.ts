/**
 * YAML frontmatter parsing and serialization utilities.
 *
 * Isomorphic — safe to use in both browser (Svelte SPA) and server
 * (Cloudflare Worker) contexts. No browser or Worker-specific APIs.
 *
 * All YAML operations use `schema: 'core'` (YAML 1.2 core schema).
 * This accepts unquoted strings (standard frontmatter convention) while
 * remaining safe — unknown `!!` tags produce warnings but no code execution
 * (JavaScript has no code execution path through YAML tags, unlike Python).
 */

import { parse, stringify } from 'yaml';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Regex to detect and capture a YAML frontmatter block at the start of
 * a document. The block must start with `---` on the first line and end
 * with `---` on its own line.
 *
 * Handles both populated and empty frontmatter blocks:
 * - `---\ntitle: Foo\n---` — captures `title: Foo`
 * - `---\n---` — captures empty string
 *
 * The `(?:\r?\n)` before the closing `---` is optional to support empty
 * blocks where the closing delimiter immediately follows the opening one.
 */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)(?:\r?\n)?---(?:\r?\n|$)/;

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/**
 * Extract and parse YAML frontmatter from the beginning of a markdown
 * document.
 *
 * @param content - Raw markdown string (may or may not contain frontmatter).
 * @returns Parsed frontmatter as a plain object, or `null` when:
 *   - No frontmatter block is present
 *   - The YAML is malformed or unparseable
 *   - The YAML parses to a non-object value (e.g. a bare string or number)
 */
export function parseFrontmatter(content: string): Record<string, unknown> | null {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return null;

  try {
    const parsed: unknown = parse(match[1], { schema: 'core' });
    // YAML can parse to null (empty block), a string, a number, etc.
    // Only return when it's an actual object.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    // Malformed YAML — return null, never throw
    return null;
  }
}

// ---------------------------------------------------------------------------
// Update (merge into existing frontmatter)
// ---------------------------------------------------------------------------

/**
 * Merge fields into a document's YAML frontmatter and return the updated
 * content string. The document body is preserved unchanged.
 *
 * Behavior:
 * - If the document has frontmatter: parse it, shallow-merge `fields`,
 *   remove keys whose value is `null`, serialize back, preserve body.
 * - If the document has no frontmatter (or it's malformed): create a
 *   new frontmatter block with `fields` (minus null-valued keys) and
 *   prepend it to the body.
 *
 * @param content - Raw markdown string.
 * @param fields  - Fields to merge. Set a value to `null` to remove a key.
 * @returns Updated markdown string with merged frontmatter.
 */
export function updateFrontmatter(
  content: string,
  fields: Record<string, unknown>,
): string {
  const match = content.match(FRONTMATTER_RE);

  let existing: Record<string, unknown> = {};
  let body: string;

  if (match) {
    // Try to parse existing frontmatter; if malformed, start fresh
    try {
      const parsed: unknown = parse(match[1], { schema: 'core' });
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed YAML — treat as empty frontmatter
    }
    // Body is everything after the closing `---` delimiter
    body = content.slice(match[0].length);
  } else {
    body = content;
  }

  // Shallow merge: new fields override existing; null values delete keys
  const merged = { ...existing, ...fields };
  for (const key of Object.keys(merged)) {
    if (merged[key] === null) {
      delete merged[key];
    }
  }

  // If all fields were removed, don't emit an empty frontmatter block
  if (Object.keys(merged).length === 0) {
    return body;
  }

  return serializeFrontmatter(merged) + body;
}

// ---------------------------------------------------------------------------
// Extract raw block
// ---------------------------------------------------------------------------

/**
 * Extract the raw YAML frontmatter block (including `---` delimiters)
 * from the beginning of a markdown document.
 *
 * Used by content-negotiation responses (`fields=frontmatter` with
 * `Accept: text/markdown`) to return the raw YAML block as-is.
 *
 * @param content - Raw markdown string.
 * @returns The raw `---\n...\n---` block, or `null` if no frontmatter exists.
 */
export function extractRawFrontmatter(content: string): string | null {
  const match = content.match(FRONTMATTER_RE);
  return match ? match[0] : null;
}

// ---------------------------------------------------------------------------
// Serialize
// ---------------------------------------------------------------------------

/**
 * Serialize an object to a YAML frontmatter block with `---` delimiters.
 *
 * The returned string includes a trailing newline after the closing `---`
 * so it can be directly prepended to a document body.
 *
 * @param fields - Object to serialize as YAML frontmatter.
 * @returns YAML frontmatter block string (e.g. `---\ntitle: Foo\n---\n`).
 */
export function serializeFrontmatter(fields: Record<string, unknown>): string {
  const yaml = stringify(fields, { schema: 'core' });
  return `---\n${yaml}---\n`;
}

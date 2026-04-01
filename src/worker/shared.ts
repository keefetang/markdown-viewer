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
// Re-exports — isomorphic escape utilities from src/shared/escape.ts
// ---------------------------------------------------------------------------

export { escapeForHtml, escapeText } from '../shared/escape';

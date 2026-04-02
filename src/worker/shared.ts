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
  /** When true, viewing requires a valid edit token. Absent/false = public. */
  private?: boolean;
  /** KV TTL in seconds. Set at creation, preserved on update.
   *  Browser sessions (Turnstile verified): 90 days.
   *  Agent sessions (no Turnstile): 30 days. */
  ttl?: number;
}

// ---------------------------------------------------------------------------
// Token comparison
// ---------------------------------------------------------------------------

/**
 * Constant-time string comparison using the Workers-native implementation.
 * Edit tokens are always nanoid(24) so lengths always match in practice.
 * A length mismatch returns false immediately — acceptable since it already
 * reveals the token is wrong without leaking content information.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  // Workers runtime provides timingSafeEqual on SubtleCrypto, but the DOM
  // lib's type definition doesn't include it — cast to access it.
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean;
  };
  return subtle.timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// Re-exports — isomorphic escape utilities from src/shared/escape.ts
// ---------------------------------------------------------------------------

export { escapeForHtml, escapeText } from '../shared/escape';

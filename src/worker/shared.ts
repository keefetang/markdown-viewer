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
  /** SHA-256 hex digest of the content. Computed on every write.
   *  Absent on older documents created before this field was added. */
  contentHash?: string;
}

// ---------------------------------------------------------------------------
// Content hashing
// ---------------------------------------------------------------------------

/**
 * Compute a SHA-256 hex digest of the given content string.
 *
 * Used on every write to produce a stable content fingerprint stored in
 * KV metadata. On read, if `metadata.contentHash` is absent (older documents),
 * this is called to compute the hash on the fly (without writing back).
 */
export async function computeContentHash(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  const hexChars: string[] = [];
  for (let i = 0; i < hashArray.length; i++) {
    hexChars.push(hashArray[i].toString(16).padStart(2, '0'));
  }
  return hexChars.join('');
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
// Session response headers
// ---------------------------------------------------------------------------

/**
 * Generate common metadata headers for session responses.
 *
 * Every session response (GET, PUT, PATCH, content-negotiation) carries these
 * headers so agents can cache, revalidate, and track document freshness.
 *
 * - `ETag`: weak ETag from `updatedAt` — `W/"<updatedAt>"`
 * - `Last-Modified`: HTTP date from `updatedAt`
 * - `X-Expires-At`: HTTP date from `updatedAt + ttl * 1000` (omitted when `ttl` is undefined)
 * - `X-Content-Hash`: SHA-256 hex digest of content (omitted when not available)
 * - `Vary: Accept`: content-negotiation signal
 */
export function sessionHeaders(metadata: SessionMetadata, contentHash?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'ETag': `W/"${metadata.updatedAt}"`,
    'Last-Modified': new Date(metadata.updatedAt).toUTCString(),
    'Vary': 'Accept',
  };

  if (metadata.ttl !== undefined) {
    headers['X-Expires-At'] = new Date(metadata.updatedAt + metadata.ttl * 1000).toUTCString();
  }

  // Prefer explicit contentHash argument; fall back to metadata for write paths
  // where the hash is freshly computed and included in metadata.
  const hash = contentHash ?? metadata.contentHash;
  if (hash) {
    headers['X-Content-Hash'] = hash;
  }

  return headers;
}

/**
 * Compute the expiry timestamp (epoch ms) from session metadata.
 * Returns `undefined` when `ttl` is not set (older sessions).
 */
export function computeExpiresAt(metadata: SessionMetadata): number | undefined {
  if (metadata.ttl === undefined) return undefined;
  return metadata.updatedAt + metadata.ttl * 1000;
}

// ---------------------------------------------------------------------------
// Conditional request helpers
// ---------------------------------------------------------------------------

/**
 * Normalize an ETag for comparison: strip the `W/` weak indicator and trim
 * whitespace, leaving just the opaque-tag (the quoted string).
 *
 * Used by both `checkIfNoneMatch` and `checkIfMatch`.
 */
export function normalizeETag(tag: string): string {
  return tag.replace(/^W\//, '').trim();
}

/**
 * Check whether a GET request's `If-None-Match` / `If-Modified-Since` headers
 * indicate the client already has the current version (→ 304 Not Modified).
 *
 * Evaluation order per RFC 9110 §13.2.2 (Precedence of Preconditions):
 *   1. If `If-None-Match` is present, compare against the current weak ETag.
 *      Result is authoritative — `If-Modified-Since` is ignored.
 *   2. Otherwise, if `If-Modified-Since` is present, compare against `updatedAt`.
 *
 * Returns `true` when the response should be 304.
 *
 * Pure function — no Request/Response construction — so Phase 6 (PATCH) can
 * reuse it without coupling to HTTP plumbing.
 */
export function checkIfNoneMatch(request: Request, updatedAt: number): boolean {
  const ifNoneMatch = request.headers.get('If-None-Match');

  if (ifNoneMatch !== null) {
    const currentETag = `W/"${updatedAt}"`;
    // Weak comparison (RFC 9110 §8.8.3.2): compare opaque-tags after stripping W/ prefix.
    // If-None-Match can be a comma-separated list of ETags.
    return ifNoneMatch.split(',').some((tag) => normalizeETag(tag) === normalizeETag(currentETag));
  }

  const ifModifiedSince = request.headers.get('If-Modified-Since');
  if (ifModifiedSince !== null) {
    const sinceMs = Date.parse(ifModifiedSince);
    if (!Number.isNaN(sinceMs)) {
      // HTTP dates have 1-second resolution; updatedAt is milliseconds.
      // Document is "not modified" when updatedAt ≤ the date the client last saw.
      return updatedAt <= sinceMs;
    }
  }

  return false;
}

/**
 * Check whether a PUT/PATCH request's `If-Match` or `If-None-Match: *` headers
 * indicate a precondition failure (→ 412 Precondition Failed).
 *
 * - `If-Match: W/"<ts>"` — succeeds only when the ETag matches the current
 *   version. Prevents accidental clobbering of concurrent edits.
 * - `If-None-Match: *` — succeeds only when the resource does NOT already
 *   exist. Enforces create-only semantics.
 *
 * Returns `true` when the response should be 412.
 *
 * Note: RFC 9110 §13.1.1 requires strong comparison for `If-Match`, but this
 * system only generates weak ETags (`W/"<updatedAt>"`). Strict strong comparison
 * would make `If-Match` unusable. We use weak comparison (strip `W/` prefix) as
 * a pragmatic deviation — matching common server behavior (nginx, Apache) when
 * only weak validators are available.
 *
 * @param request  — incoming request
 * @param updatedAt — current document's `updatedAt` timestamp, or `null` if
 *                    the session does not exist yet.
 */
// ---------------------------------------------------------------------------
// Content slicing
// ---------------------------------------------------------------------------

/**
 * Apply line-range slicing to content.
 * Shared across api.ts, mcp.ts, and index.ts for partial reads.
 */
export function sliceContent(
  content: string,
  offset?: number,
  limit?: number,
): { sliced: string; totalLines: number } {
  const lines = content.split('\n');
  const totalLines = lines.length;

  if (offset === undefined && limit === undefined) {
    return { sliced: content, totalLines };
  }

  const start = offset !== undefined ? offset - 1 : 0;
  const end = limit !== undefined ? start + limit : undefined;

  return { sliced: lines.slice(start, end).join('\n'), totalLines };
}

// ---------------------------------------------------------------------------
// Edit History
// ---------------------------------------------------------------------------

/** A single changelog entry stored in the `{id}:history` KV key. */
export interface HistoryEntry {
  /** Timestamp (epoch ms) of the change. */
  ts: number;
  /** Agent-provided description of the change. */
  summary: string;
  /** Content size in bytes after the write. */
  bytes: number;
}

/** Maximum number of history entries retained per session. */
const MAX_HISTORY_ENTRIES = 100;

/**
 * Append a changelog entry to the `{id}:history` KV key.
 *
 * Read-modify-write on KV — race condition accepted (last-write-wins,
 * worst case is a dropped entry). Designed to be called inside
 * `ctx.waitUntil()` so it doesn't block the response.
 *
 * @param kv       — KV namespace binding
 * @param id       — session ID (base key)
 * @param summary  — change description from the agent
 * @param bytes    — content size in bytes after the write
 * @param ttl      — optional KV expirationTtl in seconds (matches primary key TTL)
 */
export async function appendHistory(
  kv: KVNamespace,
  id: string,
  summary: string,
  bytes: number,
  ttl?: number,
): Promise<void> {
  const historyKey = `${id}:history`;

  // Read existing history (may not exist yet; guard against corrupted data)
  const existing = await kv.get(historyKey, 'json');
  const history: HistoryEntry[] = Array.isArray(existing) ? existing : [];

  // Prepend new entry (newest first)
  history.unshift({ ts: Date.now(), summary, bytes });

  // Cap at MAX_HISTORY_ENTRIES (trim oldest)
  if (history.length > MAX_HISTORY_ENTRIES) {
    history.length = MAX_HISTORY_ENTRIES;
  }

  // Write back with matching TTL
  const options: KVNamespacePutOptions = {};
  if (ttl !== undefined) {
    options.expirationTtl = ttl;
  }
  await kv.put(historyKey, JSON.stringify(history), options);
}

// ---------------------------------------------------------------------------
// Backlinks
// ---------------------------------------------------------------------------

/** Maximum number of backlink entries retained per session. */
const MAX_BACKLINK_ENTRIES = 500;

/**
 * Diff old and new outbound links, then update target documents' backlink
 * lists accordingly.
 *
 * Read-modify-write on KV — race condition accepted (last-write-wins,
 * worst case is a duplicate or missed backlink entry). Designed to be
 * called inside `ctx.waitUntil()` so it doesn't block the response.
 *
 * @param kv         — KV namespace binding
 * @param id         — source session ID (the document that contains links)
 * @param newLinkIds — deduplicated list of target session IDs found in content
 * @param ttl        — optional KV expirationTtl in seconds (matches primary key TTL)
 */
export async function updateLinks(
  kv: KVNamespace,
  id: string,
  newLinkIds: string[],
  ttl?: number,
): Promise<void> {
  const linksKey = `${id}:links`;

  // 1. Read old outbound links
  const existing = await kv.get(linksKey, 'json');
  const oldLinkIds: string[] = Array.isArray(existing) ? existing : [];

  // 2. Diff
  const oldSet = new Set(oldLinkIds);
  const newSet = new Set(newLinkIds);
  const added = newLinkIds.filter(targetId => !oldSet.has(targetId));
  const removed = oldLinkIds.filter(targetId => !newSet.has(targetId));

  // Source document's TTL — used for this document's own :links key
  const sourceKvOptions: KVNamespacePutOptions = {};
  if (ttl !== undefined) {
    sourceKvOptions.expirationTtl = ttl;
  }

  // 3. For each added target: add source ID to target's backlinks (parallel)
  // Use the TARGET document's TTL for its backlinks key, not the source's.
  // This prevents a short-lived source (30-day agent) from shortening
  // the backlinks TTL on a long-lived target (90-day browser).
  await Promise.all(added.map(async (targetId) => {
    const backlinksKey = `${targetId}:backlinks`;
    // Read backlinks + target metadata in parallel
    const [raw, targetMeta] = await Promise.all([
      kv.get(backlinksKey, 'json'),
      kv.getWithMetadata<SessionMetadata>(targetId).then(r => r.metadata),
    ]);
    const backlinks: string[] = Array.isArray(raw) ? raw : [];
    if (!backlinks.includes(id)) {
      backlinks.unshift(id);
      if (backlinks.length > MAX_BACKLINK_ENTRIES) {
        backlinks.length = MAX_BACKLINK_ENTRIES;
      }
    }
    const targetKvOptions: KVNamespacePutOptions = {};
    if (targetMeta?.ttl !== undefined) {
      targetKvOptions.expirationTtl = targetMeta.ttl;
    }
    await kv.put(backlinksKey, JSON.stringify(backlinks), targetKvOptions);
  }));

  // 4. For each removed target: remove source ID from target's backlinks (parallel)
  // Same pattern — use target's TTL for the target's backlinks key.
  await Promise.all(removed.map(async (targetId) => {
    const backlinksKey = `${targetId}:backlinks`;
    const [raw, targetMeta] = await Promise.all([
      kv.get(backlinksKey, 'json'),
      kv.getWithMetadata<SessionMetadata>(targetId).then(r => r.metadata),
    ]);
    const backlinks: string[] = Array.isArray(raw) ? raw : [];
    const filtered = backlinks.filter(bid => bid !== id);
    if (filtered.length > 0) {
      const targetKvOptions: KVNamespacePutOptions = {};
      if (targetMeta?.ttl !== undefined) {
        targetKvOptions.expirationTtl = targetMeta.ttl;
      }
      await kv.put(backlinksKey, JSON.stringify(filtered), targetKvOptions);
    } else {
      await kv.delete(backlinksKey);
    }
  }));

  // 5. Write updated outbound links (uses SOURCE document's TTL — this is the source's own key)
  if (newLinkIds.length > 0) {
    await kv.put(linksKey, JSON.stringify(newLinkIds), sourceKvOptions);
  } else {
    await kv.delete(linksKey);
  }
}

/**
 * Remove all outbound links for a deleted session and clean up
 * the corresponding backlink entries on target documents.
 *
 * Also deletes the session's own backlinks key.
 *
 * @param kv  — KV namespace binding
 * @param id  — the session being deleted
 */
export async function removeAllLinks(
  kv: KVNamespace,
  id: string,
): Promise<void> {
  const linksKey = `${id}:links`;

  // 1. Read outbound links to know which targets to clean up
  const existing = await kv.get(linksKey, 'json');
  const oldLinkIds: string[] = Array.isArray(existing) ? existing : [];

  // 2. Remove this ID from each target's backlinks (parallel across targets)
  await Promise.all(oldLinkIds.map(async (targetId) => {
    const backlinksKey = `${targetId}:backlinks`;
    // Read backlinks + target metadata in parallel
    const [raw, targetMeta] = await Promise.all([
      kv.get(backlinksKey, 'json'),
      kv.getWithMetadata<SessionMetadata>(targetId).then(r => r.metadata),
    ]);
    const backlinks: string[] = Array.isArray(raw) ? raw : [];
    const filtered = backlinks.filter(bid => bid !== id);
    if (filtered.length > 0) {
      const options: KVNamespacePutOptions = {};
      if (targetMeta?.ttl !== undefined) {
        options.expirationTtl = targetMeta.ttl;
      }
      await kv.put(backlinksKey, JSON.stringify(filtered), options);
    } else {
      await kv.delete(backlinksKey);
    }
  }));

  // 3. Delete this session's links and backlinks keys
  await Promise.all([
    kv.delete(linksKey),
    kv.delete(`${id}:backlinks`),
  ]);
}

// ---------------------------------------------------------------------------
// Re-exports — isomorphic escape utilities from src/shared/escape.ts
// ---------------------------------------------------------------------------

export { escapeForHtml, escapeText } from '../shared/escape';

/**
 * Shared session business logic — extracted from HTTP handlers.
 *
 * These functions handle KV access, validation, and auth checks. They return
 * result objects (not HTTP Responses) so REST API handlers, batch operations,
 * and MCP tools can all consume them uniformly.
 *
 * What stays in the HTTP layer (api.ts):
 * - Rate limiting
 * - CORS headers
 * - HTTP Response construction
 * - Turnstile verification
 * - Request body parsing
 */

import { nanoid } from 'nanoid';
import { timingSafeEqual, sessionHeaders, computeExpiresAt, computeContentHash, checkIfNoneMatch, normalizeETag, appendHistory, updateLinks, removeAllLinks } from './shared';
import type { SessionMetadata, HistoryEntry } from './shared';
import { parseFrontmatter, updateFrontmatter } from '../shared/frontmatter';

// ---------------------------------------------------------------------------
// Narrowed Env — only the bindings these functions need
// ---------------------------------------------------------------------------

interface Env {
  SESSIONS: KVNamespace;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSION_ID_RE = /^[A-Za-z0-9_-]{12}$/;
const MAX_CONTENT_LENGTH = 524_288; // 512 KB
const EXPIRATION_TTL = 7_776_000;       // 90 days — browser-created sessions
const AGENT_EXPIRATION_TTL = 2_592_000; // 30 days — agent/script-created sessions
const MAX_PATCH_OPERATIONS = 50;        // cap per-request operation count

// Re-export constants so api.ts can stay DRY
export { SESSION_ID_RE, MAX_CONTENT_LENGTH, EXPIRATION_TTL, AGENT_EXPIRATION_TTL };

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Successful result for getSession (full read). */
export interface GetSessionSuccess {
  success: true;
  id: string;
  content: string;
  metadata: { createdAt: number; updatedAt: number };
  private: boolean;
  frontmatter: Record<string, unknown> | null;
  totalLines: number;
  etag: string;
  /** SHA-256 hex digest of the content. */
  contentHash: string;
  expiresAt?: number;
  /** Session metadata headers (ETag, Last-Modified, etc.) */
  headers: Record<string, string>;
}

/** Result indicating the client has the current version (304 equivalent). */
export interface NotModifiedResult {
  success: true;
  notModified: true;
  /** Session metadata headers to include in the 304 response. */
  headers: Record<string, string>;
}

/** Error result for any session operation. */
export interface SessionError {
  success: false;
  status: number;
  error: string;
  /** Current ETag (returned on 412 Precondition Failed). */
  currentETag?: string;
}

export type GetSessionResult = GetSessionSuccess | NotModifiedResult | SessionError;

/** Successful result for putSession — CREATE (201). */
export interface PutSessionCreated {
  success: true;
  created: true;
  id: string;
  metadata: { createdAt: number; updatedAt: number };
  editToken: string;
  private: boolean;
  frontmatter: Record<string, unknown> | null;
  url: string;
  editUrl: string;
  etag: string;
  /** SHA-256 hex digest of the content. */
  contentHash: string;
  expiresAt?: number;
  headers: Record<string, string>;
}

/** Successful result for putSession — UPDATE (200). */
export interface PutSessionUpdated {
  success: true;
  created: false;
  id: string;
  metadata: { createdAt: number; updatedAt: number };
  private: boolean;
  frontmatter: Record<string, unknown> | null;
  etag: string;
  /** SHA-256 hex digest of the content. */
  contentHash: string;
  expiresAt?: number;
  headers: Record<string, string>;
}

export type PutSessionResult = PutSessionCreated | PutSessionUpdated | SessionError;

/** Options for putSession. */
export interface PutSessionOptions {
  editToken?: string;
  private?: boolean;
  ifMatch?: string | null;
  ifNoneMatchStar?: boolean;
  changeSummary?: string;
  /** Whether Turnstile was verified (determines TTL tier). */
  turnstileVerified?: boolean;
  /** Request origin URL for building share URLs in CREATE response. */
  requestOrigin?: string;
  /** Platform origin for internal link extraction (e.g. `https://markdown.pentagram.me`). */
  origin?: string;
}

/** Successful result for patchSession. */
export interface PatchSessionSuccess {
  success: true;
  id: string;
  metadata: { createdAt: number; updatedAt: number };
  private: boolean;
  frontmatter: Record<string, unknown> | null;
  etag: string;
  /** SHA-256 hex digest of the content. */
  contentHash: string;
  expiresAt?: number;
  headers: Record<string, string>;
}

/** Validation error for a specific PATCH operation. */
export interface PatchOperationFailure {
  success: false;
  status: 422;
  error: string;
  failedOperation: number;
  op: string;
}

export type PatchSessionResult = PatchSessionSuccess | PatchOperationFailure | SessionError;

/** Options for patchSession. */
export interface PatchSessionOptions {
  ifMatch?: string | null;
  changeSummary?: string;
  /** Platform origin for internal link extraction (e.g. `https://markdown.pentagram.me`). */
  origin?: string;
}

/** Successful result for deleteSession. */
export interface DeleteSessionSuccess {
  success: true;
}

export type DeleteSessionResult = DeleteSessionSuccess | SessionError;

/** Successful result for importUrl. */
export interface ImportUrlSuccess {
  success: true;
  content: string;
}

export type ImportUrlResult = ImportUrlSuccess | SessionError;

/** Successful result for getHistory. */
export interface GetHistorySuccess {
  success: true;
  id: string;
  history: HistoryEntry[];
  headers: Record<string, string>;
}

export type GetHistoryResult = GetHistorySuccess | SessionError;

/** Successful result for getBacklinks. */
export interface GetBacklinksSuccess {
  success: true;
  id: string;
  backlinks: string[];
  headers: Record<string, string>;
}

export type GetBacklinksResult = GetBacklinksSuccess | SessionError;

// ---------------------------------------------------------------------------
// Patch operation types (re-exported for api.ts and MCP tools)
// ---------------------------------------------------------------------------

/** A single operation in a PATCH request body. */
export interface PatchOperation {
  op: string;
  content?: string;
  match?: string;
  fields?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Link extraction
// ---------------------------------------------------------------------------

/**
 * Escape a string for use inside a RegExp literal.
 *
 * Only used within this module for building the origin-matching pattern.
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Scan document content and frontmatter for internal links (URLs pointing
 * to other sessions on this platform). Returns a deduplicated list of
 * target session IDs, excluding `selfId`.
 *
 * Three link sources:
 * 1. Markdown body — inline links matching `{origin}/{12-char ID}`
 * 2. `frontmatter.sources` — array of URL strings
 * 3. `frontmatter.supersedes` — single URL string
 *
 * @param content     — raw markdown content
 * @param frontmatter — parsed frontmatter (or null)
 * @param origin      — platform origin URL (e.g. `https://markdown.pentagram.me`)
 * @param selfId      — the source document's own ID (filtered out)
 */
function extractInternalLinks(
  content: string,
  frontmatter: Record<string, unknown> | null,
  origin: string,
  selfId: string,
): string[] {
  const ids = new Set<string>();
  const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{12}$/;

  // Build a pattern that matches origin + / + 12-char ID at a word-ish boundary.
  // Handles trailing slashes, query params, hash fragments — extracts just the ID.
  const pattern = new RegExp(
    `${escapeRegExp(origin)}/([A-Za-z0-9_-]{12})(?:[^A-Za-z0-9_-]|$)`,
    'g',
  );

  // Helper: extract an ID from a URL string
  const extractId = (url: string): void => {
    // Reset lastIndex for the global regex
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(url)) !== null) {
      if (SESSION_ID_PATTERN.test(match[1])) {
        ids.add(match[1]);
      }
    }
  };

  // 1. Scan markdown body for inline links
  extractId(content);

  // 2. Scan frontmatter sources and supersedes
  if (frontmatter) {
    const sources = Array.isArray(frontmatter.sources) ? frontmatter.sources : [];
    for (const src of sources) {
      if (typeof src === 'string') {
        extractId(src);
      }
    }
    if (typeof frontmatter.supersedes === 'string') {
      extractId(frontmatter.supersedes);
    }
  }

  // Filter out self-references
  ids.delete(selfId);

  return [...ids];
}

// ---------------------------------------------------------------------------
// getSession
// ---------------------------------------------------------------------------

/**
 * Read a session from KV with full access control.
 *
 * Access control:
 * - Public sessions: anyone can read.
 * - Private sessions: requires a valid edit token (returns 404 to hide existence).
 *
 * Supports conditional retrieval via If-None-Match / If-Modified-Since.
 * To use conditional retrieval, pass a Request object (or just the relevant
 * header values in a future overload).
 *
 * @param env        — Worker environment with SESSIONS KV binding.
 * @param id         — Session ID (must pass SESSION_ID_RE validation).
 * @param editToken  — Optional edit token for private session access.
 * @param request    — Optional Request for conditional retrieval (If-None-Match).
 */
export async function getSession(
  env: Env,
  id: string,
  editToken?: string,
  request?: Request,
): Promise<GetSessionResult> {
  // Validate ID format
  if (!SESSION_ID_RE.test(id)) {
    return { success: false, status: 400, error: 'Invalid session ID' };
  }

  const { value: content, metadata } =
    await env.SESSIONS.getWithMetadata<SessionMetadata>(id);

  if (content === null || metadata === null) {
    return { success: false, status: 404, error: 'Session not found' };
  }

  // Private sessions require a valid edit token — return 404 to hide existence.
  if (metadata.private) {
    if (!editToken || !timingSafeEqual(editToken, metadata.editToken)) {
      return { success: false, status: 404, error: 'Session not found' };
    }
  }

  // Conditional retrieval — 304 Not Modified when client already has current version.
  // Checked AFTER access control so private sessions still hide existence.
  if (request && checkIfNoneMatch(request, metadata.updatedAt)) {
    return {
      success: true,
      notModified: true,
      headers: sessionHeaders(metadata),
    };
  }

  const expiresAt = computeExpiresAt(metadata);
  const frontmatter = parseFrontmatter(content);
  const totalLines = content.split('\n').length;

  // Backward compat: compute hash on-the-fly for old documents without contentHash in metadata.
  // Don't write back — that would change updatedAt and reset TTL.
  const contentHash = metadata.contentHash ?? await computeContentHash(content);

  return {
    success: true,
    id,
    content,
    metadata: {
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
    },
    private: !!metadata.private,
    frontmatter,
    totalLines,
    etag: `W/"${metadata.updatedAt}"`,
    contentHash,
    ...(expiresAt !== undefined && { expiresAt }),
    headers: sessionHeaders(metadata, contentHash),
  };
}

// ---------------------------------------------------------------------------
// putSession
// ---------------------------------------------------------------------------

/**
 * Create or update a session.
 *
 * CREATE (no editToken + session doesn't exist): generates editToken, stores
 * content, returns 201 with share URLs.
 *
 * UPDATE (valid editToken + session exists): replaces content, resets TTL,
 * returns 200.
 *
 * Conditional updates (If-Match, If-None-Match: *) are supported via options.
 *
 * History append is fire-and-forget via ctx.waitUntil().
 */
export async function putSession(
  env: Env,
  ctx: ExecutionContext,
  id: string,
  content: string,
  options: PutSessionOptions = {},
): Promise<PutSessionResult> {
  // Validate ID format
  if (!SESSION_ID_RE.test(id)) {
    return { success: false, status: 400, error: 'Invalid session ID' };
  }

  // Validate content size
  const encoder = new TextEncoder();
  const contentBytes = encoder.encode(content).byteLength;
  if (contentBytes > MAX_CONTENT_LENGTH) {
    return { success: false, status: 413, error: 'Payload too large' };
  }

  // Load existing session
  const { value: existingContent, metadata: existingMeta } =
    await env.SESSIONS.getWithMetadata<SessionMetadata>(id);

  // Conditional update checks (only when session exists)
  if (existingContent !== null && existingMeta !== null) {
    // If-None-Match: * → 412 (create-only semantics: session already exists)
    if (options.ifNoneMatchStar) {
      const currentETag = `W/"${existingMeta.updatedAt}"`;
      return { success: false, status: 412, error: 'Document already exists', currentETag };
    }

    // If-Match with stale ETag → 412
    if (options.ifMatch !== undefined && options.ifMatch !== null) {
      const currentETag = `W/"${existingMeta.updatedAt}"`;
      // Weak comparison: strip W/ prefix and compare opaque-tags
      const clientTags = options.ifMatch.split(',').map(t => normalizeETag(t));
      const serverTag = normalizeETag(currentETag);
      if (!clientTags.includes(serverTag)) {
        return {
          success: false,
          status: 412,
          error: 'Document has been modified since you last read it',
          currentETag,
        };
      }
    }
  }

  const editTokenHeader = options.editToken;

  // CREATE: no token + session doesn't exist
  if (existingContent === null && !editTokenHeader) {
    const now = Date.now();
    const editToken = nanoid(24);
    const isPrivate = options.private ?? false;
    const ttl = options.turnstileVerified ? EXPIRATION_TTL : AGENT_EXPIRATION_TTL;
    const contentHash = await computeContentHash(content);
    const metadata: SessionMetadata = {
      createdAt: now,
      updatedAt: now,
      editToken,
      private: isPrivate,
      ttl,
      contentHash,
    };

    await env.SESSIONS.put(id, content, {
      metadata,
      expirationTtl: ttl,
    });

    // Non-blocking history append
    if (options.changeSummary) {
      ctx.waitUntil(appendHistory(env.SESSIONS, id, options.changeSummary, contentBytes, ttl).catch(err => {
        console.error(JSON.stringify({
          message: 'history append failed',
          error: err instanceof Error ? err.message : String(err),
          id,
        }));
      }));
    }

    const origin = options.requestOrigin ?? '';
    const createExpiresAt = computeExpiresAt(metadata);
    const frontmatter = parseFrontmatter(content);

    // Non-blocking link tracking
    if (options.origin) {
      const linkIds = extractInternalLinks(content, frontmatter, options.origin, id);
      ctx.waitUntil(updateLinks(env.SESSIONS, id, linkIds, ttl).catch(err => {
        console.error(JSON.stringify({
          message: 'link update failed',
          error: err instanceof Error ? err.message : String(err),
          id,
        }));
      }));
    }

    return {
      success: true,
      created: true,
      id,
      metadata: { createdAt: now, updatedAt: now },
      editToken,
      private: isPrivate,
      frontmatter,
      url: `${origin}/${id}`,
      editUrl: `${origin}/${id}#token=${editToken}`,
      etag: `W/"${now}"`,
      contentHash,
      ...(createExpiresAt !== undefined && { expiresAt: createExpiresAt }),
      headers: sessionHeaders(metadata, contentHash),
    };
  }

  // Session exists — verify edit token
  if (existingContent !== null && existingMeta !== null) {
    if (!editTokenHeader || !timingSafeEqual(editTokenHeader, existingMeta.editToken)) {
      return { success: false, status: 403, error: 'Forbidden' };
    }

    // UPDATE: valid token + session exists
    const now = Date.now();
    // If `private` is explicitly set, update; otherwise preserve
    const isPrivate = options.private !== undefined
      ? options.private
      : !!existingMeta.private;
    // Preserve the original TTL tier
    const ttl = existingMeta.ttl ?? EXPIRATION_TTL;
    const contentHash = await computeContentHash(content);
    const updatedMeta: SessionMetadata = {
      createdAt: existingMeta.createdAt,
      updatedAt: now,
      editToken: existingMeta.editToken,
      private: isPrivate,
      ttl,
      contentHash,
    };

    await env.SESSIONS.put(id, content, {
      metadata: updatedMeta,
      expirationTtl: ttl,
    });

    // Non-blocking history append
    if (options.changeSummary) {
      ctx.waitUntil(appendHistory(env.SESSIONS, id, options.changeSummary, contentBytes, ttl).catch(err => {
        console.error(JSON.stringify({
          message: 'history append failed',
          error: err instanceof Error ? err.message : String(err),
          id,
        }));
      }));
    }

    const updateExpiresAt = computeExpiresAt(updatedMeta);
    const frontmatter = parseFrontmatter(content);

    // Non-blocking link tracking
    if (options.origin) {
      const linkIds = extractInternalLinks(content, frontmatter, options.origin, id);
      ctx.waitUntil(updateLinks(env.SESSIONS, id, linkIds, ttl).catch(err => {
        console.error(JSON.stringify({
          message: 'link update failed',
          error: err instanceof Error ? err.message : String(err),
          id,
        }));
      }));
    }

    return {
      success: true,
      created: false,
      id,
      metadata: { createdAt: existingMeta.createdAt, updatedAt: now },
      private: isPrivate,
      frontmatter,
      etag: `W/"${now}"`,
      contentHash,
      ...(updateExpiresAt !== undefined && { expiresAt: updateExpiresAt }),
      headers: sessionHeaders(updatedMeta, contentHash),
    };
  }

  // Edge case: token provided but session doesn't exist
  return { success: false, status: 404, error: 'Session not found' };
}

// ---------------------------------------------------------------------------
// patchSession
// ---------------------------------------------------------------------------

/**
 * Apply targeted operations to a document without replacing the entire content.
 *
 * All-or-nothing semantics: if any operation fails, no changes are written.
 * Operations apply sequentially to an in-memory copy of the content.
 *
 * Requires a valid edit token. Private sessions without valid token → 404.
 */
export async function patchSession(
  env: Env,
  ctx: ExecutionContext,
  id: string,
  operations: PatchOperation[],
  editToken: string,
  options: PatchSessionOptions = {},
): Promise<PatchSessionResult> {
  // Validate ID format
  if (!SESSION_ID_RE.test(id)) {
    return { success: false, status: 400, error: 'Invalid session ID' };
  }

  // Validate operations
  if (!Array.isArray(operations) || operations.length === 0) {
    return { success: false, status: 400, error: 'operations must be a non-empty array' };
  }
  if (operations.length > MAX_PATCH_OPERATIONS) {
    return { success: false, status: 400, error: `Too many operations (max ${MAX_PATCH_OPERATIONS})` };
  }

  // Load existing session
  const { value: existingContent, metadata } =
    await env.SESSIONS.getWithMetadata<SessionMetadata>(id);

  if (existingContent === null || metadata === null) {
    return { success: false, status: 404, error: 'Session not found' };
  }

  // Auth: timing-safe compare, then return 404 for private (hides existence) or 403
  if (!timingSafeEqual(editToken, metadata.editToken)) {
    return {
      success: false,
      status: metadata.private ? 404 : 403,
      error: metadata.private ? 'Session not found' : 'Forbidden',
    };
  }

  // Conditional update: If-Match
  if (options.ifMatch !== undefined && options.ifMatch !== null) {
    const currentETag = `W/"${metadata.updatedAt}"`;
    const clientTags = options.ifMatch.split(',').map(t => normalizeETag(t));
    const serverTag = normalizeETag(currentETag);
    if (!clientTags.includes(serverTag)) {
      return {
        success: false,
        status: 412,
        error: 'Document has been modified since you last read it',
        currentETag,
      };
    }
  }

  // Apply operations sequentially to in-memory content
  let content = existingContent;

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];

    if (typeof op !== 'object' || op === null) {
      return { success: false, status: 422, error: 'Each operation must be an object', failedOperation: i, op: 'unknown' };
    }

    switch (op.op) {
      case 'append': {
        if (typeof op.content !== 'string') {
          return { success: false, status: 422, error: 'append requires a "content" string', failedOperation: i, op: op.op };
        }
        content = content + op.content;
        break;
      }

      case 'insertAfter': {
        if (typeof op.match !== 'string' || !op.match) {
          return { success: false, status: 422, error: 'insertAfter requires a non-empty "match" string', failedOperation: i, op: op.op };
        }
        if (typeof op.content !== 'string') {
          return { success: false, status: 422, error: 'insertAfter requires a "content" string', failedOperation: i, op: op.op };
        }
        const insertLines = content.split('\n');
        const insertMatches = insertLines
          .map((line, idx) => line.includes(op.match!) ? idx : -1)
          .filter(idx => idx !== -1);

        if (insertMatches.length === 0) {
          return { success: false, status: 422, error: 'No line matches the provided string', failedOperation: i, op: op.op };
        }
        if (insertMatches.length > 1) {
          return { success: false, status: 422, error: 'Multiple lines match — provide more specific text', failedOperation: i, op: op.op };
        }

        const insertIndex = insertMatches[0];
        insertLines.splice(insertIndex + 1, 0, ...op.content.split('\n'));
        content = insertLines.join('\n');
        break;
      }

      case 'replaceLine': {
        if (typeof op.match !== 'string' || !op.match) {
          return { success: false, status: 422, error: 'replaceLine requires a non-empty "match" string', failedOperation: i, op: op.op };
        }
        if (typeof op.content !== 'string') {
          return { success: false, status: 422, error: 'replaceLine requires a "content" string', failedOperation: i, op: op.op };
        }
        const replaceLines = content.split('\n');
        const replaceMatches = replaceLines
          .map((line, idx) => line.includes(op.match!) ? idx : -1)
          .filter(idx => idx !== -1);

        if (replaceMatches.length === 0) {
          return { success: false, status: 422, error: 'No line matches the provided string', failedOperation: i, op: op.op };
        }
        if (replaceMatches.length > 1) {
          return { success: false, status: 422, error: 'Multiple lines match — provide more specific text', failedOperation: i, op: op.op };
        }

        const replaceIndex = replaceMatches[0];
        if (op.content === '') {
          replaceLines.splice(replaceIndex, 1);
        } else {
          replaceLines.splice(replaceIndex, 1, ...op.content.split('\n'));
        }
        content = replaceLines.join('\n');
        break;
      }

      case 'updateFrontmatter': {
        if (typeof op.fields !== 'object' || op.fields === null || Array.isArray(op.fields)) {
          return { success: false, status: 422, error: 'updateFrontmatter requires a "fields" object', failedOperation: i, op: op.op };
        }
        content = updateFrontmatter(content, op.fields);
        break;
      }

      default:
        return {
          success: false,
          status: 422,
          error: `Unknown operation: ${String(op.op)}`,
          failedOperation: i,
          op: String(op.op),
        };
    }
  }

  // Check result document size
  const encoder = new TextEncoder();
  const contentBytes = encoder.encode(content).byteLength;
  if (contentBytes > MAX_CONTENT_LENGTH) {
    return { success: false, status: 413, error: 'Result document exceeds 512 KB limit' };
  }

  // Write updated content to KV
  const now = Date.now();
  const ttl = metadata.ttl ?? EXPIRATION_TTL;
  const contentHash = await computeContentHash(content);
  const updatedMeta: SessionMetadata = {
    createdAt: metadata.createdAt,
    updatedAt: now,
    editToken: metadata.editToken,
    private: metadata.private,
    ttl,
    contentHash,
  };

  await env.SESSIONS.put(id, content, {
    metadata: updatedMeta,
    expirationTtl: ttl,
  });

  // History append (non-blocking)
  if (options.changeSummary) {
    ctx.waitUntil(appendHistory(env.SESSIONS, id, options.changeSummary, contentBytes, ttl).catch(err => {
      console.error(JSON.stringify({
        message: 'history append failed',
        error: err instanceof Error ? err.message : String(err),
        id,
      }));
    }));
  }

  const expiresAt = computeExpiresAt(updatedMeta);
  const frontmatter = parseFrontmatter(content);

  // Non-blocking link tracking
  if (options.origin) {
    const linkIds = extractInternalLinks(content, frontmatter, options.origin, id);
    ctx.waitUntil(updateLinks(env.SESSIONS, id, linkIds, ttl).catch(err => {
      console.error(JSON.stringify({
        message: 'link update failed',
        error: err instanceof Error ? err.message : String(err),
        id,
      }));
    }));
  }

  return {
    success: true,
    id,
    metadata: { createdAt: metadata.createdAt, updatedAt: now },
    private: !!metadata.private,
    frontmatter,
    etag: `W/"${now}"`,
    contentHash,
    ...(expiresAt !== undefined && { expiresAt }),
    headers: sessionHeaders(updatedMeta, contentHash),
  };
}

// ---------------------------------------------------------------------------
// deleteSession
// ---------------------------------------------------------------------------

/**
 * Delete a session, its history key, and clean up link tracking.
 *
 * Requires a valid edit token. Returns 403 without valid token,
 * 404 if session doesn't exist. Link cleanup (removing this doc from
 * targets' backlinks) is non-blocking via `ctx.waitUntil()`.
 */
export async function deleteSession(
  env: Env,
  ctx: ExecutionContext,
  id: string,
  editToken: string,
): Promise<DeleteSessionResult> {
  // Validate ID format
  if (!SESSION_ID_RE.test(id)) {
    return { success: false, status: 400, error: 'Invalid session ID' };
  }

  if (!editToken) {
    return { success: false, status: 403, error: 'Forbidden' };
  }

  const { value: existingContent, metadata: existingMeta } =
    await env.SESSIONS.getWithMetadata<SessionMetadata>(id);

  if (existingContent === null || existingMeta === null) {
    return { success: false, status: 404, error: 'Session not found' };
  }

  if (!timingSafeEqual(editToken, existingMeta.editToken)) {
    // Private sessions hide existence — return 404 instead of 403
    return {
      success: false,
      status: existingMeta.private ? 404 : 403,
      error: existingMeta.private ? 'Session not found' : 'Forbidden',
    };
  }

  // Delete session + secondary keys
  await Promise.all([
    env.SESSIONS.delete(id),
    env.SESSIONS.delete(`${id}:history`),
  ]);

  // Non-blocking link cleanup (removes this doc from targets' backlinks, deletes links + backlinks keys)
  ctx.waitUntil(removeAllLinks(env.SESSIONS, id).catch(err => {
    console.error(JSON.stringify({
      message: 'link cleanup failed',
      error: err instanceof Error ? err.message : String(err),
      id,
    }));
  }));

  return { success: true };
}

// ---------------------------------------------------------------------------
// getHistory
// ---------------------------------------------------------------------------

/**
 * Retrieve changelog entries for a session.
 *
 * Access control: private sessions require a valid edit token (returns 404
 * to hide existence). Returns empty history array if no history key exists.
 */
export async function getHistory(
  env: Env,
  id: string,
  editToken?: string,
): Promise<GetHistoryResult> {
  // Validate ID format
  if (!SESSION_ID_RE.test(id)) {
    return { success: false, status: 400, error: 'Invalid session ID' };
  }

  // Verify the session exists (and check access control for private sessions)
  const { metadata } = await env.SESSIONS.getWithMetadata<SessionMetadata>(id);

  if (metadata === null) {
    return { success: false, status: 404, error: 'Session not found' };
  }

  // Private sessions require a valid edit token — return 404 to hide existence.
  if (metadata.private) {
    if (!editToken || !timingSafeEqual(editToken, metadata.editToken)) {
      return { success: false, status: 404, error: 'Session not found' };
    }
  }

  // Read the history key (may not exist; guard against corrupted data)
  const raw = await env.SESSIONS.get(`${id}:history`, 'json');
  const history: HistoryEntry[] = Array.isArray(raw) ? raw : [];

  return {
    success: true,
    id,
    history,
    headers: sessionHeaders(metadata),
  };
}

// ---------------------------------------------------------------------------
// getBacklinks
// ---------------------------------------------------------------------------

/**
 * Retrieve the list of documents that link to this session.
 *
 * Access control: private sessions require a valid edit token (returns 404
 * to hide existence). Returns empty backlinks array if no backlinks key exists.
 */
export async function getBacklinks(
  env: Env,
  id: string,
  editToken?: string,
): Promise<GetBacklinksResult> {
  // Validate ID format
  if (!SESSION_ID_RE.test(id)) {
    return { success: false, status: 400, error: 'Invalid session ID' };
  }

  // Verify the session exists (and check access control for private sessions)
  const { metadata } = await env.SESSIONS.getWithMetadata<SessionMetadata>(id);

  if (metadata === null) {
    return { success: false, status: 404, error: 'Session not found' };
  }

  // Private sessions require a valid edit token — return 404 to hide existence.
  if (metadata.private) {
    if (!editToken || !timingSafeEqual(editToken, metadata.editToken)) {
      return { success: false, status: 404, error: 'Session not found' };
    }
  }

  // Read the backlinks key (may not exist; guard against corrupted data)
  const raw = await env.SESSIONS.get(`${id}:backlinks`, 'json');
  const backlinks: string[] = Array.isArray(raw) ? raw : [];

  return {
    success: true,
    id,
    backlinks,
    headers: sessionHeaders(metadata),
  };
}

// ---------------------------------------------------------------------------
// importUrl
// ---------------------------------------------------------------------------

const MAX_IMPORT_REDIRECTS = 3;
const IMPORT_TIMEOUT_MS = 5000;
const MAX_IMPORT_BYTES = 524_288; // 512 KB

/** Content types we explicitly allow for URL import. */
const ALLOWED_IMPORT_TYPES = [
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'application/markdown',
  'application/x-markdown',
];

/** Content types we reject with a specific, helpful hint. */
const REJECTED_TYPE_HINTS: Record<string, string> = {
  'text/html': 'This URL returned HTML, not markdown. Try the raw file URL.',
  'application/xhtml+xml': 'This URL returned HTML, not markdown. Try the raw file URL.',
  'application/json': 'This URL returned JSON, not markdown.',
};

/**
 * Securely fetch text content from a URL with an 11-step validation chain.
 *
 * Does NOT need env or ctx — pure HTTP fetch with validation.
 *
 * @param url — HTTPS URL to fetch.
 * @returns Result with content string or error.
 */
export async function importUrl(url: string): Promise<ImportUrlResult> {
  try {
    // Step 1: Scheme validation
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { success: false, status: 400, error: 'Invalid URL format' };
    }
    if (parsed.protocol !== 'https:') {
      return { success: false, status: 400, error: 'Only HTTPS URLs are supported' };
    }

    // Step 2: Credentials rejection
    if (parsed.username || parsed.password) {
      return { success: false, status: 400, error: 'URLs with credentials are not supported' };
    }

    // Step 3: Hostname blocking
    if (isBlockedHost(parsed.hostname)) {
      return { success: false, status: 400, error: 'URL points to a private or reserved address' };
    }

    // Step 4: Fetch with manual redirect handling (re-validates 1-3 per hop)
    // Step 5: Timeout via AbortSignal.timeout(5000) in fetchWithRedirects
    const response = await fetchWithRedirects(url);

    // Step 6: Content-Type validation
    const responseContentType = response.headers.get('Content-Type') || '';
    const mimeType = responseContentType.split(';')[0].trim().toLowerCase();

    if (REJECTED_TYPE_HINTS[mimeType]) {
      return { success: false, status: 422, error: REJECTED_TYPE_HINTS[mimeType] };
    }
    if (mimeType && !ALLOWED_IMPORT_TYPES.includes(mimeType) && !mimeType.startsWith('text/')) {
      return { success: false, status: 422, error: `Unsupported content type: ${mimeType}` };
    }

    // Steps 7-9: Streaming body read + UTF-8 validation + null byte check
    const content = await readBodyAsText(response);

    // Steps 10-11: Return text only + response header isolation
    return { success: true, content };
  } catch (e) {
    // ImportError from the validation pipeline
    if (e instanceof ImportError) {
      return { success: false, status: e.status, error: e.message };
    }
    // TypeError from new URL() in fetchWithRedirects
    if (e instanceof TypeError && e.message.includes('URL')) {
      return { success: false, status: 400, error: 'Invalid URL format' };
    }
    // Timeout from AbortSignal.timeout()
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      return { success: false, status: 504, error: 'Request timed out' };
    }
    // Catch-all for unexpected fetch failures
    console.error(JSON.stringify({
      message: 'import-url error',
      error: e instanceof Error ? e.message : String(e),
    }));
    return { success: false, status: 502, error: 'Failed to fetch URL' };
  }
}

// ---------------------------------------------------------------------------
// Import URL internal helpers
// ---------------------------------------------------------------------------

/** Typed error for the URL import pipeline. */
class ImportError extends Error {
  name = 'ImportError';
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/**
 * Check whether a hostname resolves to a private, loopback, link-local,
 * or cloud metadata address.
 */
function isBlockedHost(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (lower === 'localhost' || lower === '0.0.0.0' || lower === '::' || lower === '::1') return true;
  if (lower === '169.254.169.254') return true;
  if (lower === 'metadata.google.internal' || lower === 'metadata.google.com') return true;

  if (lower.startsWith('::ffff:')) {
    const mapped = lower.slice(7);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(mapped)) return isBlockedHost(mapped);
    return true;
  }

  const ipv4Match = lower.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4Match) {
    const [, aStr, bStr] = ipv4Match;
    const a = Number(aStr);
    const b = Number(bStr);
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
  }

  if (lower.startsWith('fe80:')) return true;
  if (lower.startsWith('fc00:')) return true;
  if (lower.startsWith('fd00:')) return true;

  return false;
}

/** Fetch a URL with manual redirect handling and SSRF re-validation per hop. */
async function fetchWithRedirects(url: string, maxRedirects = MAX_IMPORT_REDIRECTS): Promise<Response> {
  let currentUrl = url;
  const timeoutSignal = AbortSignal.timeout(IMPORT_TIMEOUT_MS);

  for (let i = 0; i <= maxRedirects; i++) {
    const parsed = new URL(currentUrl);
    if (parsed.protocol !== 'https:') {
      throw new ImportError('Redirect to non-HTTPS URL', 400);
    }
    if (parsed.username || parsed.password) {
      throw new ImportError('Redirect URL contains credentials', 400);
    }
    if (isBlockedHost(parsed.hostname)) {
      throw new ImportError('Redirect points to a private or reserved address', 400);
    }

    const response = await fetch(currentUrl, {
      redirect: 'manual',
      signal: timeoutSignal,
      headers: {
        'User-Agent': 'markdown-viewer/1.0 (URL Import)',
        'Accept': 'text/plain, text/markdown, application/markdown, text/*',
      },
    });

    if (response.status < 300 || response.status >= 400) {
      return response;
    }

    const location = response.headers.get('Location');
    if (!location) {
      throw new ImportError('Redirect without Location header', 400);
    }

    currentUrl = new URL(location, currentUrl).href;
  }

  throw new ImportError('Too many redirects', 400);
}

/** Read a response body as text with streaming byte counting, strict UTF-8, and null byte detection. */
async function readBodyAsText(response: Response, maxBytes = MAX_IMPORT_BYTES): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new ImportError('Empty response body', 422);

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks: string[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new ImportError('Response exceeds 512 KB limit', 413);
      }

      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } catch (e) {
    if (e instanceof ImportError) throw e;
    throw new ImportError('Content is not valid text', 422);
  }

  const content = chunks.join('');

  if (content.includes('\0')) {
    throw new ImportError('Content appears to be binary', 422);
  }

  return content;
}

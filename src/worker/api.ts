import {
  getSession,
  putSession,
  patchSession,
  deleteSession,
  getHistory,
  getBacklinks,
  importUrl,
  SESSION_ID_RE,
  MAX_CONTENT_LENGTH,
} from './sessions';
import { normalizeETag, sliceContent } from './shared';
import type {
  PatchOperation,
  GetSessionSuccess,
  GetSessionResult,
} from './sessions';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Env {
  SESSIONS: KVNamespace;
  // Rate limiting is optional — the Deploy to Cloudflare button may not
  // auto-provision rate limit bindings. When absent, the app functions
  // without rate limiting (Turnstile + edit tokens are the primary defenses).
  WRITE_LIMITER?: RateLimit;
  READ_LIMITER?: RateLimit;
  TURNSTILE_SECRET_KEY?: string;
  CORS_ORIGIN?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(
  body: unknown,
  status: number,
  corsHeaders: Headers,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...Object.fromEntries(corsHeaders),
      ...extraHeaders,
    },
  });
}

function errorResponse(message: string, status: number, corsHeaders: Headers): Response {
  return jsonResponse({ error: message }, status, corsHeaders);
}

function corsHeaders(env: Env): Headers {
  const headers = new Headers();
  headers.set('Access-Control-Allow-Origin', env.CORS_ORIGIN || '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Edit-Token, X-Private, If-Match, If-None-Match, If-Modified-Since, X-Change-Summary');
  headers.set('Access-Control-Expose-Headers', 'ETag, Last-Modified, Content-Length, X-Expires-At, X-Content-Hash');
  headers.set('Access-Control-Max-Age', '86400');
  return headers;
}

/**
 * Extract the session ID from a `/api/sessions/:id`, `/api/sessions/:id/history`,
 * or `/api/sessions/:id/backlinks` path.
 * Returns `null` if the path doesn't match the expected pattern.
 */
function extractSessionId(pathname: string): string | null {
  const prefix = '/api/sessions/';
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  // Handle known sub-routes — strip the suffix
  let id = rest;
  if (id.endsWith('/history')) id = id.slice(0, -'/history'.length);
  else if (id.endsWith('/backlinks')) id = id.slice(0, -'/backlinks'.length);
  // Reject if there's anything else after the ID (e.g. trailing slashes or unknown sub-paths)
  if (id.includes('/')) return null;
  return id || null;
}

/**
 * Check whether the pathname is a history sub-route: `/api/sessions/:id/history`.
 */
function isHistoryRoute(pathname: string): boolean {
  return pathname.startsWith('/api/sessions/') && pathname.endsWith('/history');
}

/**
 * Check whether the pathname is a backlinks sub-route: `/api/sessions/:id/backlinks`.
 */
function isBacklinksRoute(pathname: string): boolean {
  return pathname.startsWith('/api/sessions/') && pathname.endsWith('/backlinks');
}

// ---------------------------------------------------------------------------
// Partial read helpers
// ---------------------------------------------------------------------------

/** Parsed and validated partial read parameters from query string. */
interface PartialReadParams {
  offset?: number;
  limit?: number;
  fieldsOnly?: 'frontmatter';
}

/**
 * Parse `offset`, `limit`, and `fields` query parameters for partial reads.
 * Returns `null` with an error message if validation fails.
 */
function parsePartialReadParams(
  url: URL,
): { params: PartialReadParams } | { error: string } {
  const params: PartialReadParams = {};

  const offsetStr = url.searchParams.get('offset');
  if (offsetStr !== null) {
    const n = Number(offsetStr);
    if (!Number.isInteger(n) || n < 1) {
      return { error: 'offset must be a positive integer' };
    }
    params.offset = n;
  }

  const limitStr = url.searchParams.get('limit');
  if (limitStr !== null) {
    const n = Number(limitStr);
    if (!Number.isInteger(n) || n < 1) {
      return { error: 'limit must be a positive integer' };
    }
    params.limit = n;
  }

  const fields = url.searchParams.get('fields');
  if (fields !== null) {
    if (fields !== 'frontmatter') {
      return { error: 'fields must be "frontmatter"' };
    }
    params.fieldsOnly = 'frontmatter';
  }

  return { params };
}

// sliceContent imported from shared.ts

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * Check a rate limiter binding keyed on the client IP.
 * Returns a 429 Response if the limit is exceeded, or `null` to proceed.
 */
async function checkRateLimit(
  limiter: RateLimit | undefined,
  request: Request,
  cors: Headers,
): Promise<Response | null> {
  if (!limiter) return null;

  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const { success } = await limiter.limit({ key: ip });
  if (!success) {
    const headers = new Headers({
      'Content-Type': 'application/json',
      'Retry-After': '60',
      ...Object.fromEntries(cors),
    });
    return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
      status: 429,
      headers,
    });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Turnstile verification
// ---------------------------------------------------------------------------

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Verify a Turnstile token via the siteverify API.
 * Returns `true` if verification passes or if the Turnstile service is
 * unreachable (fail-open for availability — rate limiting is the fallback).
 * Returns `false` only when the service explicitly rejects the token.
 */
async function verifyTurnstile(
  secretKey: string,
  token: string,
  remoteIp: string,
): Promise<boolean> {
  try {
    const formData = new FormData();
    formData.append('secret', secretKey);
    formData.append('response', token);
    formData.append('remoteip', remoteIp);

    const result = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      body: formData,
    });
    const outcome = await result.json<{ success: boolean }>();
    return outcome.success === true;
  } catch (err) {
    console.error(JSON.stringify({
      message: 'turnstile verification failed',
      error: err instanceof Error ? err.message : String(err),
    }));
    return true;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Handle all `/api/*` requests. CORS preflight (OPTIONS) is handled by
 * the caller in index.ts — this function handles GET, PUT, PATCH, DELETE.
 */
export async function handleApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const cors = corsHeaders(env);
  const url = new URL(request.url);
  const { pathname } = url;

  try {
    // --- Batch routes (before session ID extraction) ---
    if (pathname === '/api/sessions/batch/read' && request.method === 'POST') {
      return await handleBatchRead(request, env, cors);
    }
    if (pathname === '/api/sessions/batch/update' && request.method === 'POST') {
      return await handleBatchUpdate(request, env, ctx, cors);
    }

    // --- Extract & validate session ID ---
    const id = extractSessionId(pathname);
    if (id === null) {
      return errorResponse('Not found', 404, cors);
    }
    if (!SESSION_ID_RE.test(id)) {
      return errorResponse('Invalid session ID', 400, cors);
    }

    // --- History sub-route: GET /api/sessions/:id/history ---
    if (isHistoryRoute(pathname)) {
      if (request.method !== 'GET') {
        return errorResponse('Method not allowed', 405, cors);
      }
      const rateLimited = await checkRateLimit(env.READ_LIMITER, request, cors);
      if (rateLimited) return rateLimited;
      return await handleGetHistory(id, request, env, cors);
    }

    // --- Backlinks sub-route: GET /api/sessions/:id/backlinks ---
    if (isBacklinksRoute(pathname)) {
      if (request.method !== 'GET') {
        return errorResponse('Method not allowed', 405, cors);
      }
      const rateLimited = await checkRateLimit(env.READ_LIMITER, request, cors);
      if (rateLimited) return rateLimited;
      return await handleGetBacklinks(id, request, env, cors);
    }

    // --- Rate limiting ---
    const isWrite = request.method === 'PUT' || request.method === 'PATCH' || request.method === 'DELETE';
    const limiter = isWrite ? env.WRITE_LIMITER : env.READ_LIMITER;
    const rateLimited = await checkRateLimit(limiter, request, cors);
    if (rateLimited) return rateLimited;

    // --- Route by method ---
    switch (request.method) {
      case 'GET':
        return await handleGet(id, request, env, cors);
      case 'PUT':
        return await handlePut(id, request, env, ctx, cors);
      case 'PATCH':
        return await handlePatch(id, request, env, ctx, cors);
      case 'DELETE':
        return await handleDelete(id, request, env, ctx, cors);
      default:
        return errorResponse('Method not allowed', 405, cors);
    }
  } catch (err) {
    console.error(JSON.stringify({
      message: 'api error',
      error: err instanceof Error ? err.message : String(err),
      path: pathname,
    }));
    return errorResponse('Internal server error', 500, cors);
  }
}

/**
 * Build an OPTIONS preflight response with CORS headers.
 */
export function handleCorsPreflight(env: Env): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(env),
  });
}

// ---------------------------------------------------------------------------
// Endpoint handlers — thin HTTP wrappers over shared session logic
// ---------------------------------------------------------------------------

async function handleGet(
  id: string,
  request: Request,
  env: Env,
  cors: Headers,
): Promise<Response> {
  // --- Parse partial read params early (before KV read) to fail fast ---
  const url = new URL(request.url);
  const parsed = parsePartialReadParams(url);
  if ('error' in parsed) {
    return errorResponse(parsed.error, 400, cors);
  }
  const { offset, limit, fieldsOnly } = parsed.params;

  // --- Call shared getSession logic ---
  const editToken = request.headers.get('X-Edit-Token') || undefined;
  const result = await getSession(env, id, editToken, request);

  if (!result.success) {
    return errorResponse(result.error, result.status, cors);
  }

  // 304 Not Modified
  if ('notModified' in result) {
    return new Response(null, {
      status: 304,
      headers: {
        ...Object.fromEntries(cors),
        ...result.headers,
      },
    });
  }

  // Narrow type: full session data
  const session = result as GetSessionSuccess;

  // Single split: compute totalLines and sliced content in one pass
  const { sliced, totalLines } = sliceContent(session.content, offset, limit);

  // --- fields=frontmatter: metadata-only response (no content) ---
  if (fieldsOnly === 'frontmatter') {
    return jsonResponse(
      {
        id,
        metadata: session.metadata,
        private: session.private,
        frontmatter: session.frontmatter,
        totalLines,
        etag: session.etag,
        contentHash: session.contentHash,
        ...(session.expiresAt !== undefined && { expiresAt: session.expiresAt }),
      },
      200,
      cors,
      session.headers,
    );
  }

  // --- Build response with optional line-range info ---
  const isPartial = offset !== undefined || limit !== undefined;

  return jsonResponse(
    {
      id,
      content: sliced,
      metadata: session.metadata,
      private: session.private,
      frontmatter: session.frontmatter,
      totalLines,
      ...(isPartial && { range: { offset: offset ?? 1, limit } }),
      etag: session.etag,
      contentHash: session.contentHash,
      ...(session.expiresAt !== undefined && { expiresAt: session.expiresAt }),
    },
    200,
    cors,
    session.headers,
  );
}

async function handlePut(
  id: string,
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  cors: Headers,
): Promise<Response> {
  // --- Content-Type handling ---
  const contentType = request.headers.get('Content-Type') ?? '';
  const isMarkdownBody = contentType.includes('text/markdown');
  if (!isMarkdownBody && !contentType.includes('application/json')) {
    return errorResponse('Unsupported Media Type — use application/json or text/markdown', 415, cors);
  }

  // --- Content-Length pre-check (reject before reading body) ---
  const contentLength = request.headers.get('Content-Length');
  if (contentLength !== null) {
    const length = Number(contentLength);
    if (!Number.isNaN(length) && length > MAX_CONTENT_LENGTH) {
      return errorResponse('Payload too large', 413, cors);
    }
  }

  // --- Parse body ---
  let content: string;
  let record: Record<string, unknown> = {};

  if (isMarkdownBody) {
    content = await request.text();
    if (!content && content !== '') {
      return errorResponse('Empty body', 400, cors);
    }
  } else {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse('Invalid JSON', 400, cors);
    }
    if (typeof body !== 'object' || body === null) {
      return errorResponse('Invalid request body', 400, cors);
    }
    record = body as Record<string, unknown>;
    if (typeof record.content !== 'string') {
      return errorResponse('Invalid request body', 400, cors);
    }
    content = record.content;
  }

  // --- Turnstile verification (only on creation, only if configured) ---
  const turnstileToken = typeof record.turnstileToken === 'string' ? record.turnstileToken : null;
  let hasTurnstile = false;

  if (env.TURNSTILE_SECRET_KEY && turnstileToken) {
    const remoteIp = request.headers.get('cf-connecting-ip') || '';
    const valid = await verifyTurnstile(env.TURNSTILE_SECRET_KEY, turnstileToken, remoteIp);
    if (!valid) {
      return errorResponse('Bot verification failed', 403, cors);
    }
    hasTurnstile = true;
  }

  // --- Extract changeSummary (JSON body field or X-Change-Summary header) ---
  const changeSummary = typeof record.changeSummary === 'string' && record.changeSummary.trim()
    ? record.changeSummary.trim()
    : request.headers.get('X-Change-Summary')?.trim() || '';

  // --- Determine private flag ---
  const privateHeader = request.headers.get('X-Private');
  const isPrivate = typeof record.private === 'boolean'
    ? record.private
    : privateHeader !== null
      ? privateHeader === 'true'
      : undefined;  // undefined = preserve existing

  // --- Extract conditional headers ---
  const ifNoneMatch = request.headers.get('If-None-Match');
  const ifMatch = request.headers.get('If-Match');

  // --- Call shared putSession logic ---
  const requestUrl = new URL(request.url);
  const result = await putSession(env, ctx, id, content, {
    editToken: request.headers.get('X-Edit-Token') || undefined,
    private: isPrivate,
    ifMatch: ifMatch,
    ifNoneMatchStar: ifNoneMatch !== null && ifNoneMatch.trim() === '*',
    changeSummary: changeSummary || undefined,
    turnstileVerified: hasTurnstile,
    requestOrigin: requestUrl.origin,
    origin: requestUrl.origin,
  });

  if (!result.success) {
    if (result.currentETag) {
      return jsonResponse(
        { error: result.error, currentETag: result.currentETag },
        result.status,
        cors,
        { 'ETag': result.currentETag },
      );
    }
    return errorResponse(result.error, result.status, cors);
  }

  // CREATE response (201)
  if (result.created) {
    return jsonResponse(
      {
        id: result.id,
        metadata: result.metadata,
        editToken: result.editToken,
        private: result.private,
        url: result.url,
        editUrl: result.editUrl,
        etag: result.etag,
        contentHash: result.contentHash,
        ...(result.expiresAt !== undefined && { expiresAt: result.expiresAt }),
      },
      201,
      cors,
      result.headers,
    );
  }

  // UPDATE response (200) — now includes frontmatter (normalizing with PATCH)
  return jsonResponse(
    {
      id: result.id,
      metadata: result.metadata,
      private: result.private,
      frontmatter: result.frontmatter,
      etag: result.etag,
      contentHash: result.contentHash,
      ...(result.expiresAt !== undefined && { expiresAt: result.expiresAt }),
    },
    200,
    cors,
    result.headers,
  );
}

async function handlePatch(
  id: string,
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  cors: Headers,
): Promise<Response> {
  // --- Require edit token ---
  const editTokenHeader = request.headers.get('X-Edit-Token');
  if (!editTokenHeader) {
    return errorResponse('Forbidden', 403, cors);
  }

  // --- Parse request body ---
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON', 400, cors);
  }

  if (typeof body !== 'object' || body === null) {
    return errorResponse('Invalid request body', 400, cors);
  }
  const record = body as Record<string, unknown>;

  if (!Array.isArray(record.operations) || record.operations.length === 0) {
    return errorResponse('operations must be a non-empty array', 400, cors);
  }
  const operations = record.operations as PatchOperation[];

  // --- Extract changeSummary and If-Match ---
  const changeSummary = typeof record.changeSummary === 'string' && record.changeSummary.trim()
    ? record.changeSummary.trim()
    : request.headers.get('X-Change-Summary')?.trim() || '';

  const ifMatch = request.headers.get('If-Match');

  // --- Call shared patchSession logic ---
  const result = await patchSession(env, ctx, id, operations, editTokenHeader, {
    ifMatch: ifMatch,
    changeSummary: changeSummary || undefined,
    origin: new URL(request.url).origin,
  });

  if (!result.success) {
    // 422 with operation failure details
    if ('failedOperation' in result) {
      return jsonResponse(
        { error: result.error, failedOperation: result.failedOperation, op: result.op },
        422,
        cors,
      );
    }
    // 412 with currentETag (SessionError branch)
    if ('currentETag' in result && result.currentETag) {
      return jsonResponse(
        { error: result.error, currentETag: result.currentETag },
        result.status,
        cors,
        { 'ETag': result.currentETag },
      );
    }
    return errorResponse(result.error, result.status, cors);
  }

  return jsonResponse(
    {
      id: result.id,
      metadata: result.metadata,
      private: result.private,
      frontmatter: result.frontmatter,
      etag: result.etag,
      contentHash: result.contentHash,
      ...(result.expiresAt !== undefined && { expiresAt: result.expiresAt }),
    },
    200,
    cors,
    result.headers,
  );
}

async function handleDelete(
  id: string,
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  cors: Headers,
): Promise<Response> {
  const editTokenHeader = request.headers.get('X-Edit-Token');
  if (!editTokenHeader) {
    return errorResponse('Forbidden', 403, cors);
  }

  const result = await deleteSession(env, ctx, id, editTokenHeader);

  if (!result.success) {
    return errorResponse(result.error, result.status, cors);
  }

  return new Response(null, {
    status: 204,
    headers: Object.fromEntries(cors),
  });
}

// ---------------------------------------------------------------------------
// History retrieval
// ---------------------------------------------------------------------------

async function handleGetHistory(
  id: string,
  request: Request,
  env: Env,
  cors: Headers,
): Promise<Response> {
  const editToken = request.headers.get('X-Edit-Token') || undefined;
  const result = await getHistory(env, id, editToken);

  if (!result.success) {
    return errorResponse(result.error, result.status, cors);
  }

  return jsonResponse(
    {
      id: result.id,
      history: result.history,
    },
    200,
    cors,
    result.headers,
  );
}

// ---------------------------------------------------------------------------
// Backlinks retrieval
// ---------------------------------------------------------------------------

async function handleGetBacklinks(
  id: string,
  request: Request,
  env: Env,
  cors: Headers,
): Promise<Response> {
  const editToken = request.headers.get('X-Edit-Token') || undefined;
  const result = await getBacklinks(env, id, editToken);

  if (!result.success) {
    return errorResponse(result.error, result.status, cors);
  }

  return jsonResponse(
    {
      id: result.id,
      backlinks: result.backlinks,
    },
    200,
    cors,
    result.headers,
  );
}

// ---------------------------------------------------------------------------
// Batch Read
// ---------------------------------------------------------------------------

/** Maximum number of documents in a single batch read request. */
const MAX_BATCH_READ_IDS = 20;

/**
 * Handle `POST /api/sessions/batch/read` — read multiple documents in one
 * request with per-document auth and conditional reads.
 *
 * Rate limiting: each document counts as one read against READ_LIMITER.
 * The limiter is checked N times sequentially before the parallel reads.
 */
async function handleBatchRead(
  request: Request,
  env: Env,
  cors: Headers,
): Promise<Response> {
  // --- Parse request body ---
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON', 400, cors);
  }

  if (typeof body !== 'object' || body === null) {
    return errorResponse('Invalid request body', 400, cors);
  }
  const record = body as Record<string, unknown>;

  // --- Validate ids ---
  if (!Array.isArray(record.ids)) {
    return errorResponse('ids must be an array', 400, cors);
  }
  const rawIds = record.ids as unknown[];
  if (rawIds.length === 0) {
    return errorResponse('ids must not be empty', 400, cors);
  }
  if (rawIds.length > MAX_BATCH_READ_IDS) {
    return errorResponse(`Too many ids (max ${MAX_BATCH_READ_IDS})`, 400, cors);
  }

  // Separate valid IDs from invalid ones upfront — invalid IDs go straight
  // to errors without consuming rate limit tokens or triggering KV reads.
  const validIds: string[] = [];
  const errors: Record<string, unknown>[] = [];

  for (const rawId of rawIds) {
    if (typeof rawId !== 'string') {
      errors.push({ id: String(rawId), status: 400, error: 'Invalid session ID' });
    } else if (!SESSION_ID_RE.test(rawId)) {
      errors.push({ id: rawId, status: 400, error: 'Invalid session ID' });
    } else {
      validIds.push(rawId);
    }
  }

  // --- Validate optional tokens map ---
  const tokens: Record<string, string> = {};
  if (record.tokens !== undefined) {
    if (typeof record.tokens !== 'object' || record.tokens === null || Array.isArray(record.tokens)) {
      return errorResponse('tokens must be an object', 400, cors);
    }
    for (const [k, v] of Object.entries(record.tokens as Record<string, unknown>)) {
      if (typeof v === 'string') {
        tokens[k] = v;
      }
    }
  }

  // --- Validate optional etags map ---
  const etags: Record<string, string> = {};
  if (record.etags !== undefined) {
    if (typeof record.etags !== 'object' || record.etags === null || Array.isArray(record.etags)) {
      return errorResponse('etags must be an object', 400, cors);
    }
    for (const [k, v] of Object.entries(record.etags as Record<string, unknown>)) {
      if (typeof v === 'string') {
        etags[k] = v;
      }
    }
  }

  // --- Validate optional partial read params ---
  let offset: number | undefined;
  let limit: number | undefined;
  let fieldsOnly: 'frontmatter' | undefined;

  if (record.offset !== undefined) {
    if (typeof record.offset !== 'number' || !Number.isInteger(record.offset) || record.offset < 1) {
      return errorResponse('offset must be a positive integer', 400, cors);
    }
    offset = record.offset;
  }
  if (record.limit !== undefined) {
    if (typeof record.limit !== 'number' || !Number.isInteger(record.limit) || record.limit < 1) {
      return errorResponse('limit must be a positive integer', 400, cors);
    }
    limit = record.limit;
  }
  if (record.fields !== undefined) {
    if (record.fields !== 'frontmatter') {
      return errorResponse('fields must be "frontmatter"', 400, cors);
    }
    fieldsOnly = 'frontmatter';
  }

  // --- Rate limiting: consume N reads (one per valid document) ---
  // The simple rate limiter only supports consuming 1 unit at a time,
  // so we call it N times sequentially before the parallel reads.
  // Only valid IDs count — invalid IDs are already in the errors array.
  if (env.READ_LIMITER && validIds.length > 0) {
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    for (let i = 0; i < validIds.length; i++) {
      const { success } = await env.READ_LIMITER.limit({ key: ip });
      if (!success) {
        const headers = new Headers({
          'Content-Type': 'application/json',
          'Retry-After': '60',
          ...Object.fromEntries(cors),
        });
        return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
          status: 429,
          headers,
        });
      }
    }
  }

  // --- Parallel reads via Promise.allSettled ---
  const readPromises = validIds.map((id) => {
    const token = tokens[id] || undefined;
    return getSession(env, id, token);
  });

  const settled = await Promise.allSettled(readPromises);

  // --- Assemble response ---
  const documents: Record<string, unknown>[] = [];

  for (let i = 0; i < settled.length; i++) {
    const id = validIds[i];
    const outcome = settled[i];

    // Unexpected rejection (shouldn't happen — getSession doesn't throw)
    if (outcome.status === 'rejected') {
      errors.push({ id, status: 500, error: 'Internal error' });
      continue;
    }

    const result: GetSessionResult = outcome.value;

    // Error from getSession (404, 403, etc.)
    if (!result.success) {
      errors.push({ id, status: result.status, error: result.error });
      continue;
    }

    // 304 equivalent from getSession (notModified) — shouldn't happen without
    // a Request object, but handle defensively. Extract ETag from response
    // headers when available, fall back to client-provided ETag.
    if ('notModified' in result) {
      const serverETag = result.headers?.['ETag'] ?? etags[id] ?? null;
      documents.push({ id, unchanged: true, etag: serverETag });
      continue;
    }

    // Full session data — check client-provided ETags for conditional reads
    const session = result as GetSessionSuccess;
    const clientETag = etags[id];
    if (clientETag !== undefined) {
      // Weak comparison: strip W/ prefix, compare opaque-tags
      if (normalizeETag(clientETag) === normalizeETag(session.etag)) {
        documents.push({ id, unchanged: true, etag: session.etag });
        continue;
      }
    }

    // Apply line-range slicing
    const { sliced, totalLines } = sliceContent(session.content, offset, limit);
    const isPartial = offset !== undefined || limit !== undefined;

    // fields=frontmatter: metadata-only response (no content)
    if (fieldsOnly === 'frontmatter') {
      documents.push({
        id,
        metadata: session.metadata,
        private: session.private,
        frontmatter: session.frontmatter,
        totalLines,
        etag: session.etag,
        contentHash: session.contentHash,
        ...(session.expiresAt !== undefined && { expiresAt: session.expiresAt }),
      });
      continue;
    }

    // Full document response
    documents.push({
      id,
      content: sliced,
      metadata: session.metadata,
      private: session.private,
      frontmatter: session.frontmatter,
      totalLines,
      ...(isPartial && { range: { offset: offset ?? 1, limit } }),
      etag: session.etag,
      contentHash: session.contentHash,
      ...(session.expiresAt !== undefined && { expiresAt: session.expiresAt }),
    });
  }

  return jsonResponse({ documents, errors }, 200, cors);
}

// ---------------------------------------------------------------------------
// Batch Update
// ---------------------------------------------------------------------------

/** Maximum number of updates in a single batch request. */
const MAX_BATCH_UPDATES = 10;

/** A single validated update item in a batch update request body. */
interface BatchUpdateItem {
  id: string;
  editToken: string;
  content: string;
  ifMatch?: string;
  changeSummary?: string;
  private?: boolean;
}

/**
 * Handle `POST /api/sessions/batch/update` — update multiple documents
 * in one request with per-document auth and conditional logic.
 *
 * Each update goes through the same validation as a single PUT. Updates
 * are processed sequentially to avoid rate limit counter races. Rate
 * limiting is checked per-update — if the limiter is exhausted mid-batch,
 * remaining updates are collected as 429 errors.
 *
 * Not atomic: each update succeeds or fails independently.
 */
async function handleBatchUpdate(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  cors: Headers,
): Promise<Response> {
  // --- Parse request body ---
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON', 400, cors);
  }

  if (typeof body !== 'object' || body === null) {
    return errorResponse('Invalid request body', 400, cors);
  }

  const record = body as Record<string, unknown>;

  if (!Array.isArray(record.updates)) {
    return errorResponse('updates must be an array', 400, cors);
  }

  const updates = record.updates as unknown[];

  if (updates.length === 0) {
    return errorResponse('updates must be a non-empty array', 400, cors);
  }

  if (updates.length > MAX_BATCH_UPDATES) {
    return errorResponse(`Too many updates (max ${MAX_BATCH_UPDATES})`, 400, cors);
  }

  // --- Validate each update item shape before processing ---
  const validatedUpdates: BatchUpdateItem[] = [];
  for (let i = 0; i < updates.length; i++) {
    const item = updates[i];
    if (typeof item !== 'object' || item === null) {
      return errorResponse(`updates[${i}] must be an object`, 400, cors);
    }
    const rec = item as Record<string, unknown>;

    if (typeof rec.id !== 'string' || !SESSION_ID_RE.test(rec.id)) {
      return errorResponse(`updates[${i}].id must be a valid session ID`, 400, cors);
    }
    if (typeof rec.editToken !== 'string' || !rec.editToken) {
      return errorResponse(`updates[${i}].editToken is required`, 400, cors);
    }
    if (typeof rec.content !== 'string') {
      return errorResponse(`updates[${i}].content must be a string`, 400, cors);
    }
    if (rec.ifMatch !== undefined && typeof rec.ifMatch !== 'string') {
      return errorResponse(`updates[${i}].ifMatch must be a string`, 400, cors);
    }
    if (rec.changeSummary !== undefined && typeof rec.changeSummary !== 'string') {
      return errorResponse(`updates[${i}].changeSummary must be a string`, 400, cors);
    }
    if (rec.private !== undefined && typeof rec.private !== 'boolean') {
      return errorResponse(`updates[${i}].private must be a boolean`, 400, cors);
    }

    validatedUpdates.push({
      id: rec.id,
      editToken: rec.editToken,
      content: rec.content,
      ifMatch: rec.ifMatch as string | undefined,
      changeSummary: rec.changeSummary as string | undefined,
      private: rec.private as boolean | undefined,
    });
  }

  // --- Process updates sequentially (avoids rate limit counter races) ---
  const results: Record<string, unknown>[] = [];
  const errors: Record<string, unknown>[] = [];

  for (const update of validatedUpdates) {
    // Per-update rate limiting — checked before each write
    const rateLimited = await checkRateLimit(env.WRITE_LIMITER, request, cors);
    if (rateLimited) {
      errors.push({
        id: update.id,
        status: 429,
        error: 'Rate limit exceeded',
      });
      continue;
    }

    const result = await putSession(env, ctx, update.id, update.content, {
      editToken: update.editToken,
      private: update.private,
      ifMatch: update.ifMatch ?? null,
      changeSummary: update.changeSummary?.trim() || undefined,
      origin: new URL(request.url).origin,
    });

    if (!result.success) {
      const errorEntry: Record<string, unknown> = {
        id: update.id,
        status: result.status,
        error: result.error,
      };
      if (result.currentETag) {
        errorEntry.currentETag = result.currentETag;
      }
      errors.push(errorEntry);
      continue;
    }

    // Build success entry
    const successEntry: Record<string, unknown> = {
      id: result.id,
      metadata: result.metadata,
      private: result.private,
      frontmatter: result.frontmatter,
      etag: result.etag,
      contentHash: result.contentHash,
    };
    if (result.expiresAt !== undefined) {
      successEntry.expiresAt = result.expiresAt;
    }
    results.push(successEntry);
  }

  return jsonResponse({ results, errors }, 200, cors);
}

// ---------------------------------------------------------------------------
// URL Import — thin HTTP wrapper over shared importUrl logic
// ---------------------------------------------------------------------------

/**
 * Handle `POST /api/import-url` — securely proxy-fetch an external URL
 * and return its text content.
 */
export async function handleImportUrl(request: Request, env: Env): Promise<Response> {
  const cors = corsHeaders(env);

  // --- Rate limiting (shares WRITE_LIMITER budget with session writes) ---
  const rateLimited = await checkRateLimit(env.WRITE_LIMITER, request, cors);
  if (rateLimited) return rateLimited;

  // --- Parse request body ---
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON', 400, cors);
  }

  if (typeof body !== 'object' || body === null) {
    return errorResponse('Missing url field', 400, cors);
  }
  const record = body as Record<string, unknown>;
  if (!record.url || typeof record.url !== 'string') {
    return errorResponse('Missing url field', 400, cors);
  }

  // --- Call shared importUrl logic ---
  const result = await importUrl(record.url);

  if (!result.success) {
    return errorResponse(result.error, result.status, cors);
  }

  return jsonResponse({ content: result.content }, 200, cors);
}

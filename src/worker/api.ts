import { nanoid } from 'nanoid';
import type { SessionMetadata } from './shared';

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
// Constants
// ---------------------------------------------------------------------------

const SESSION_ID_RE = /^[A-Za-z0-9_-]{12}$/;
const MAX_CONTENT_LENGTH = 524_288; // 512 KB
const EXPIRATION_TTL = 7_776_000;   // 90 days in seconds

// ---------------------------------------------------------------------------
// Token comparison (constant-time for equal-length strings)
// ---------------------------------------------------------------------------

/**
 * Constant-time string comparison using the Workers-native implementation.
 * Edit tokens are always nanoid(24) so lengths always match in practice.
 * A length mismatch returns false immediately — acceptable since it already
 * reveals the token is wrong without leaking content information.
 */
function timingSafeEqual(a: string, b: string): boolean {
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
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status: number, corsHeaders: Headers): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...Object.fromEntries(corsHeaders),
    },
  });
}

function errorResponse(message: string, status: number, corsHeaders: Headers): Response {
  return jsonResponse({ error: message }, status, corsHeaders);
}

function corsHeaders(env: Env): Headers {
  const headers = new Headers();
  headers.set('Access-Control-Allow-Origin', env.CORS_ORIGIN || '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Edit-Token');
  headers.set('Access-Control-Max-Age', '86400');
  return headers;
}

/**
 * Extract the session ID from a `/api/sessions/:id` path.
 * Returns `null` if the path doesn't match the expected pattern.
 */
function extractSessionId(pathname: string): string | null {
  const prefix = '/api/sessions/';
  if (!pathname.startsWith(prefix)) return null;
  const id = pathname.slice(prefix.length);
  // Reject if there's anything after the ID (e.g. trailing slashes or sub-paths)
  if (id.includes('/')) return null;
  return id || null;
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * Check a rate limiter binding keyed on the client IP.
 * Returns a 429 Response if the limit is exceeded, or `null` to proceed.
 * When the limiter binding is not provisioned, returns `null` (allow).
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
    // Turnstile infrastructure unavailable — fail open for availability.
    // Rate limiting is the secondary defense if Turnstile is down.
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
 * the caller in index.ts — this function handles GET, PUT, DELETE.
 */
export async function handleApi(request: Request, env: Env): Promise<Response> {
  const cors = corsHeaders(env);
  const url = new URL(request.url);
  const { pathname } = url;

  try {
    // --- Extract & validate session ID ---
    const id = extractSessionId(pathname);
    if (id === null) {
      return errorResponse('Not found', 404, cors);
    }
    if (!SESSION_ID_RE.test(id)) {
      return errorResponse('Invalid session ID', 400, cors);
    }

    // --- Rate limiting ---
    const isWrite = request.method === 'PUT' || request.method === 'DELETE';
    const limiter = isWrite ? env.WRITE_LIMITER : env.READ_LIMITER;
    const rateLimited = await checkRateLimit(limiter, request, cors);
    if (rateLimited) return rateLimited;

    // --- Route by method ---
    switch (request.method) {
      case 'GET':
        return await handleGet(id, env, cors);
      case 'PUT':
        return await handlePut(id, request, env, cors);
      case 'DELETE':
        return await handleDelete(id, request, env, cors);
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
// Endpoint handlers
// ---------------------------------------------------------------------------

async function handleGet(
  id: string,
  env: Env,
  cors: Headers,
): Promise<Response> {
  const { value: content, metadata } =
    await env.SESSIONS.getWithMetadata<SessionMetadata>(id);

  if (content === null || metadata === null) {
    return errorResponse('Session not found', 404, cors);
  }

  return jsonResponse(
    {
      id,
      content,
      metadata: {
        createdAt: metadata.createdAt,
        updatedAt: metadata.updatedAt,
      },
    },
    200,
    cors,
  );
}

async function handlePut(
  id: string,
  request: Request,
  env: Env,
  cors: Headers,
): Promise<Response> {
  // --- Content-Type validation ---
  const contentType = request.headers.get('Content-Type') ?? '';
  if (!contentType.includes('application/json')) {
    return errorResponse('Unsupported Media Type', 415, cors);
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
  if (typeof record.content !== 'string') {
    return errorResponse('Invalid request body', 400, cors);
  }
  const content = record.content;

  // --- Double-check content size after parsing ---
  const encoder = new TextEncoder();
  if (encoder.encode(content).byteLength > MAX_CONTENT_LENGTH) {
    return errorResponse('Payload too large', 413, cors);
  }

  // --- Load existing session ---
  const { value: existingContent, metadata: existingMeta } =
    await env.SESSIONS.getWithMetadata<SessionMetadata>(id);

  const editTokenHeader = request.headers.get('X-Edit-Token');

  // CREATE: no token + session doesn't exist → generate editToken, store, return 201
  if (existingContent === null && !editTokenHeader) {
    // --- Turnstile verification (only on creation, only if configured) ---
    if (env.TURNSTILE_SECRET_KEY) {
      const turnstileToken = typeof record.turnstileToken === 'string' ? record.turnstileToken : null;
      if (!turnstileToken) {
        return errorResponse('Bot verification failed', 403, cors);
      }
      const remoteIp = request.headers.get('cf-connecting-ip') || '';
      const valid = await verifyTurnstile(env.TURNSTILE_SECRET_KEY, turnstileToken, remoteIp);
      if (!valid) {
        return errorResponse('Bot verification failed', 403, cors);
      }
    }

    const now = Date.now();
    const editToken = nanoid(24);
    const metadata: SessionMetadata = {
      createdAt: now,
      updatedAt: now,
      editToken,
    };

    await env.SESSIONS.put(id, content, {
      metadata,
      expirationTtl: EXPIRATION_TTL,
    });

    return jsonResponse(
      {
        id,
        metadata: { createdAt: now, updatedAt: now },
        editToken,
      },
      201,
      cors,
    );
  }

  // Session exists — verify edit token
  if (existingContent !== null && existingMeta !== null) {
    if (!editTokenHeader || !timingSafeEqual(editTokenHeader, existingMeta.editToken)) {
      // FORBIDDEN: no/invalid token + session exists
      return errorResponse('Forbidden', 403, cors);
    }

    // UPDATE: valid token + session exists → reset TTL, return 200
    const now = Date.now();
    const metadata: SessionMetadata = {
      createdAt: existingMeta.createdAt,
      updatedAt: now,
      editToken: existingMeta.editToken,
    };

    await env.SESSIONS.put(id, content, {
      metadata,
      expirationTtl: EXPIRATION_TTL,
    });

    return jsonResponse(
      {
        id,
        metadata: { createdAt: existingMeta.createdAt, updatedAt: now },
      },
      200,
      cors,
    );
  }

  // Edge case: token provided but session doesn't exist
  return errorResponse('Session not found', 404, cors);
}

async function handleDelete(
  id: string,
  request: Request,
  env: Env,
  cors: Headers,
): Promise<Response> {
  const editTokenHeader = request.headers.get('X-Edit-Token');
  if (!editTokenHeader) {
    return errorResponse('Forbidden', 403, cors);
  }

  const { value: existingContent, metadata: existingMeta } =
    await env.SESSIONS.getWithMetadata<SessionMetadata>(id);

  if (existingContent === null || existingMeta === null) {
    return errorResponse('Session not found', 404, cors);
  }

  if (!timingSafeEqual(editTokenHeader, existingMeta.editToken)) {
    return errorResponse('Forbidden', 403, cors);
  }

  await env.SESSIONS.delete(id);

  return new Response(null, {
    status: 204,
    headers: Object.fromEntries(cors),
  });
}

// ---------------------------------------------------------------------------
// URL Import — Secure proxy for fetching external markdown
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
 * Typed error for the URL import pipeline. Each validation step throws
 * an ImportError with a user-facing message and HTTP status code.
 */
class ImportError extends Error {
  name = 'ImportError';
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

// ---- Step 3: Hostname blocking (SSRF prevention) ----

/**
 * Check whether a hostname resolves to a private, loopback, link-local,
 * or cloud metadata address. Uses the **normalized** hostname from
 * `new URL()` so hex/octal/decimal-encoded IPs are caught automatically.
 *
 * Applied to the initial URL AND every redirect destination.
 */
function isBlockedHost(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets

  // Exact-match blocklist
  if (lower === 'localhost' || lower === '0.0.0.0' || lower === '::' || lower === '::1') return true;
  if (lower === '169.254.169.254') return true;
  if (lower === 'metadata.google.internal' || lower === 'metadata.google.com') return true;

  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1)
  // Block conservatively — all ::ffff: addresses map to IPv4 and could target private ranges
  if (lower.startsWith('::ffff:')) {
    const mapped = lower.slice(7);
    // Dotted-decimal form: recurse to check the embedded IPv4 address
    if (/^\d+\.\d+\.\d+\.\d+$/.test(mapped)) return isBlockedHost(mapped);
    // Hex form (e.g. ::ffff:7f00:1) — block all mapped addresses conservatively
    return true;
  }

  // IPv4 range checks
  const ipv4Match = lower.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4Match) {
    const [, aStr, bStr] = ipv4Match;
    const a = Number(aStr);
    const b = Number(bStr);
    if (a === 127) return true;                        // 127.0.0.0/8 loopback
    if (a === 10) return true;                         // 10.0.0.0/8 private
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true;            // 192.168.0.0/16 private
    if (a === 169 && b === 254) return true;            // 169.254.0.0/16 link-local
    if (a === 0) return true;                          // 0.0.0.0/8
  }

  // IPv6 private/link-local ranges
  if (lower.startsWith('fe80:')) return true;   // link-local
  if (lower.startsWith('fc00:')) return true;   // unique local (private)
  if (lower.startsWith('fd00:')) return true;   // unique local (private)

  return false;
}

// ---- Step 4: Manual redirect handling ----

/**
 * Fetch a URL with manual redirect handling. On every hop (including
 * the initial request), re-validates scheme, credentials, and hostname
 * to prevent SSRF via redirect chains.
 */
async function fetchWithRedirects(url: string, maxRedirects = MAX_IMPORT_REDIRECTS): Promise<Response> {
  let currentUrl = url;
  // Single timeout signal shared across all hops — caps total fetch time at 5s
  const timeoutSignal = AbortSignal.timeout(IMPORT_TIMEOUT_MS);

  for (let i = 0; i <= maxRedirects; i++) {
    // Re-validate steps 1-3 on EVERY hop
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
      redirect: 'manual', // SECURITY: follow redirects manually to re-validate SSRF checks on each hop
      signal: timeoutSignal,
      headers: {
        'User-Agent': 'markdown-viewer/1.0 (URL Import)',
        'Accept': 'text/plain, text/markdown, application/markdown, text/*',
      },
    });

    // Not a redirect — return the final response
    if (response.status < 300 || response.status >= 400) {
      return response;
    }

    // It's a redirect — extract and validate the Location header
    const location = response.headers.get('Location');
    if (!location) {
      throw new ImportError('Redirect without Location header', 400);
    }

    // Resolve relative redirect URLs against the current URL
    currentUrl = new URL(location, currentUrl).href;
  }

  throw new ImportError('Too many redirects', 400);
}

// ---- Steps 7-9: Streaming body read + UTF-8 validation + null bytes ----

/**
 * Read a response body as text with streaming byte counting, strict
 * UTF-8 validation, and null byte detection for binary content.
 */
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

      // TextDecoder with fatal: true throws on invalid UTF-8 bytes
      chunks.push(decoder.decode(value, { stream: true }));
    }
    // Flush the decoder (catches trailing incomplete sequences)
    chunks.push(decoder.decode());
  } catch (e) {
    if (e instanceof ImportError) throw e;
    throw new ImportError('Content is not valid text', 422);
  }

  const content = chunks.join('');

  // Step 9: Null byte check — catches binary content disguised as text
  if (content.includes('\0')) {
    throw new ImportError('Content appears to be binary', 422);
  }

  return content;
}

// ---- Main handler ----

/**
 * Handle `POST /api/import-url` — securely proxy-fetch an external URL
 * and return its text content. Implements an 11-step validation chain
 * against SSRF, binary injection, and information leakage.
 */
export async function handleImportUrl(request: Request, env: Env): Promise<Response> {
  const cors = corsHeaders(env);

  try {
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

    const targetUrl = record.url;

    // --- Step 1: Scheme validation ---
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      return errorResponse('Invalid URL format', 400, cors);
    }
    if (parsed.protocol !== 'https:') {
      return errorResponse('Only HTTPS URLs are supported', 400, cors);
    }

    // --- Step 2: Credentials rejection ---
    if (parsed.username || parsed.password) {
      return errorResponse('URLs with credentials are not supported', 400, cors);
    }

    // --- Step 3: Hostname blocking ---
    if (isBlockedHost(parsed.hostname)) {
      return errorResponse('URL points to a private or reserved address', 400, cors);
    }

    // --- Step 4: Fetch with manual redirect handling (re-validates 1-3 per hop) ---
    // --- Step 5: Timeout via AbortSignal.timeout(5000) in fetchWithRedirects ---
    const response = await fetchWithRedirects(targetUrl);

    // --- Step 6: Content-Type validation ---
    const responseContentType = response.headers.get('Content-Type') || '';
    const mimeType = responseContentType.split(';')[0].trim().toLowerCase();

    if (REJECTED_TYPE_HINTS[mimeType]) {
      throw new ImportError(REJECTED_TYPE_HINTS[mimeType], 422);
    }
    // Allow empty/missing Content-Type — many raw file hosts omit it.
    // Steps 7-9 (UTF-8 validation + null byte check) catch actual binary.
    if (mimeType && !ALLOWED_IMPORT_TYPES.includes(mimeType) && !mimeType.startsWith('text/')) {
      throw new ImportError(`Unsupported content type: ${mimeType}`, 422);
    }

    // --- Steps 7-9: Streaming body read + UTF-8 validation + null byte check ---
    const content = await readBodyAsText(response);

    // --- Steps 10-11: Return text only + response header isolation ---
    // jsonResponse constructs a fresh Response — no upstream headers forwarded
    return jsonResponse({ content }, 200, cors);
  } catch (e) {
    // --- Structured error handling for the full pipeline ---
    if (e instanceof ImportError) {
      return errorResponse(e.message, e.status, cors);
    }
    // TypeError from new URL() in fetchWithRedirects
    if (e instanceof TypeError && e.message.includes('URL')) {
      return errorResponse('Invalid URL format', 400, cors);
    }
    // Timeout from AbortSignal.timeout()
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      return errorResponse('Request timed out', 504, cors);
    }
    // Catch-all for unexpected fetch failures
    console.error(JSON.stringify({
      message: 'import-url error',
      error: e instanceof Error ? e.message : String(e),
    }));
    return errorResponse('Failed to fetch URL', 502, cors);
  }
}

/**
 * API client for session endpoints.
 *
 * All requests use relative URLs — no hardcoded domain.
 * The `X-Edit-Token` header is included only when a token is provided.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionData {
  id: string;
  content: string;
  metadata: { createdAt: number; updatedAt: number };
}

/** Server response for session creation (PUT without token, 201). */
export interface CreateResponse {
  id: string;
  editToken: string;
  metadata: { createdAt: number; updatedAt: number };
}

/** Server response for session update (PUT with token, 200). */
export interface UpdateResponse {
  id: string;
  metadata: { createdAt: number; updatedAt: number };
}

/** Error subclass for API errors that carry an HTTP status code. */
export class ApiError extends Error {
  override name = 'ApiError';
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tokenHeaders(editToken?: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (editToken) {
    headers['X-Edit-Token'] = editToken;
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch an existing session by ID.
 * Returns `null` on 404 (session not found or expired).
 */
export async function getSession(id: string): Promise<SessionData | null> {
  const res = await fetch(`/api/sessions/${id}`);

  if (res.status === 404) return null;

  if (!res.ok) {
    throw new ApiError(res.status, `GET /api/sessions/${id} failed: ${res.status}`);
  }

  return (await res.json()) as SessionData;
}

/**
 * Create or update a session.
 *
 * - Without `editToken`: creates a new session → returns `CreateResponse` with `editToken`.
 *   Optionally includes a `turnstileToken` for bot verification on creation.
 * - With `editToken`: updates an existing session → returns `UpdateResponse`.
 *
 * Throws `ApiError` on failure (403, 413, 429, etc.).
 */
export async function saveSession(
  id: string,
  content: string,
  editToken?: string,
  turnstileToken?: string | null,
): Promise<CreateResponse | UpdateResponse> {
  // Include turnstileToken in the body only for creation requests (no editToken)
  const body: Record<string, string> = { content };
  if (!editToken && turnstileToken) {
    body.turnstileToken = turnstileToken;
  }

  const res = await fetch(`/api/sessions/${id}`, {
    method: 'PUT',
    headers: tokenHeaders(editToken),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new ApiError(res.status, `PUT /api/sessions/${id} failed: ${res.status}`);
  }

  return (await res.json()) as CreateResponse | UpdateResponse;
}

/**
 * Delete a session. Requires a valid edit token.
 * Returns `true` on success (204), `false` on 404.
 * Throws `ApiError` on 403 or other failures.
 */
export async function deleteSession(id: string, editToken: string): Promise<boolean> {
  const res = await fetch(`/api/sessions/${id}`, {
    method: 'DELETE',
    headers: { 'X-Edit-Token': editToken },
  });

  if (res.status === 204) return true;
  if (res.status === 404) return false;

  throw new ApiError(res.status, `DELETE /api/sessions/${id} failed: ${res.status}`);
}

/**
 * Import markdown from an external URL via the server proxy.
 * Never throws — returns `{ content }` on success, or `{ error }` with a user-facing message.
 * The server handles SSRF prevention, content validation, and size limits.
 */
export async function importUrl(url: string): Promise<{ content: string } | { error: string }> {
  try {
    const res = await fetch('/api/import-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = (await res.json()) as { content?: string; error?: string };
    if (!res.ok || 'error' in data) {
      return { error: data.error ?? `Import failed (${res.status})` };
    }
    return data as { content: string };
  } catch {
    return { error: 'Failed to fetch URL' };
  }
}

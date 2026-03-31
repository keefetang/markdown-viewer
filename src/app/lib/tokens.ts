/**
 * Edit token management.
 *
 * Tokens grant write access to a session. They are stored in localStorage
 * keyed by session ID, and are NEVER visible in the URL bar.
 *
 * Shared edit links use `/:id#token=...` — the hash fragment is extracted
 * on page load, persisted to localStorage, and immediately removed from
 * the URL via `history.replaceState`.
 */

const STORAGE_PREFIX = 'md-token:';

// ---------------------------------------------------------------------------
// localStorage operations
// ---------------------------------------------------------------------------

/** Store an edit token for a session. */
export function storeToken(sessionId: string, token: string): void {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${sessionId}`, token);
  } catch {
    // localStorage full or unavailable — token won't persist across reloads,
    // but the session remains functional for this page lifetime.
  }
}

/** Retrieve the stored edit token for a session, or `null` if none. */
export function getStoredToken(sessionId: string): string | null {
  try {
    return localStorage.getItem(`${STORAGE_PREFIX}${sessionId}`);
  } catch {
    return null;
  }
}

/** Remove the stored edit token for a session. */
export function removeToken(sessionId: string): void {
  try {
    localStorage.removeItem(`${STORAGE_PREFIX}${sessionId}`);
  } catch {
    // Best effort — if localStorage is unavailable, nothing to remove.
  }
}

// ---------------------------------------------------------------------------
// URL hash extraction
// ---------------------------------------------------------------------------

/**
 * Extract an edit token from the URL hash (`#token=...`) and clean the
 * URL bar. The caller is responsible for storing the token via `storeToken`.
 *
 * Returns the extracted token, or `null` if no token was found in the hash.
 *
 * After extraction, `history.replaceState` removes the hash so the URL bar
 * never shows the token — a hard UX requirement.
 */
export function extractAndCleanToken(): string | null {
  const hash = window.location.hash;
  if (!hash) return null;

  // Match #token=<value> — the value runs to end of string (no further hash params)
  const match = hash.match(/^#token=(.+)$/);
  if (!match) return null;

  const token = decodeURIComponent(match[1]);

  // Clean the URL bar: remove the hash entirely
  history.replaceState(null, '', window.location.pathname + window.location.search);

  return token;
}

/**
 * Client-side Turnstile integration (invisible, optional).
 *
 * Reads `window.__TURNSTILE_KEY__` injected by the Worker via HTMLRewriter.
 * If the key isn't set, all functions are no-ops — the editor works without Turnstile.
 *
 * The invisible widget runs in the background on page load. The resolved token
 * is single-use and expires after 300s. On expiry the widget re-challenges silently.
 * On failure (ad blocker, network), the token resolves to `null` — the server
 * decides whether to accept or reject (graceful degradation).
 */

// ---------------------------------------------------------------------------
// Global declaration for the injected site key
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    __TURNSTILE_KEY__?: string;
    __onTurnstileLoad?: () => void;
    turnstile?: {
      render(
        container: HTMLElement,
        options: {
          sitekey: string;
          callback: (token: string) => void;
          'error-callback': () => void;
          'expired-callback': () => void;
          size: 'invisible';
        },
      ): string;
    };
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let turnstileToken: string | null = null;
let tokenPromise: Promise<string | null> | null = null;
let initialized = false;

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/**
 * Create an invisible container for Turnstile, append to DOM, and return it.
 * Turnstile requires the container to be in the document to function.
 */
function createTurnstileContainer(): HTMLDivElement {
  const container = document.createElement('div');
  container.style.position = 'absolute';
  container.style.width = '0';
  container.style.height = '0';
  container.style.overflow = 'hidden';
  document.body.appendChild(container);
  return container;
}

/**
 * Remove a Turnstile container from the DOM if it's still attached.
 */
function removeTurnstileContainer(container: HTMLDivElement): void {
  if (container.parentNode) {
    container.parentNode.removeChild(container);
  }
}

/**
 * Run a Turnstile challenge. Assumes `window.turnstile` is already loaded.
 * Returns a promise that resolves with the challenge token (or null on
 * failure/timeout). On token expiry, re-challenges silently and updates
 * the module-level `tokenPromise` for future callers.
 */
function runChallenge(siteKey: string): Promise<string | null> {
  turnstileToken = null;

  const container = createTurnstileContainer();

  return new Promise<string | null>((resolve) => {
    try {
      window.turnstile!.render(container, {
        sitekey: siteKey,
        callback: (token: string) => {
          turnstileToken = token;
          removeTurnstileContainer(container);
          resolve(token);
        },
        'error-callback': () => {
          // Graceful degradation — proceed without token
          removeTurnstileContainer(container);
          resolve(null);
        },
        'expired-callback': () => {
          // Token expired — clean up old container, re-challenge silently.
          // Update module-level promise so future getTurnstileToken() callers
          // await the new challenge instead of getting the stale resolved one.
          removeTurnstileContainer(container);
          tokenPromise = runChallenge(siteKey);
        },
        size: 'invisible',
      });
    } catch {
      // window.turnstile unavailable or render threw — proceed without token
      removeTurnstileContainer(container);
      resolve(null);
      return;
    }

    // Timeout: if challenge doesn't resolve in 10s, proceed without it
    setTimeout(() => {
      removeTurnstileContainer(container);
      resolve(null);
    }, 10_000);
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check if Turnstile is configured (site key was injected by the Worker).
 */
export function isTurnstileConfigured(): boolean {
  return !!window.__TURNSTILE_KEY__;
}

/**
 * Initialize Turnstile on the current page.
 * Call once during app mount. No-ops if Turnstile is not configured
 * or if already initialized. Loads the Turnstile script from CDN once, then
 * runs an invisible challenge. Re-challenges on token expiry without reloading
 * the script.
 *
 * The resolved token is stored in memory for `getTurnstileToken()`.
 */
export function initTurnstile(): void {
  const siteKey = window.__TURNSTILE_KEY__;
  if (!siteKey) return; // Turnstile not configured — skip silently
  if (initialized) return; // Already initialized — skip

  initialized = true;

  // This promise covers the entire init: script loading + first challenge.
  // getTurnstileToken() awaits this until the first token is available.
  // Two separate timeouts handle two separate failure modes:
  //   1. Script-loading timeout (below) — CDN blocked or slow
  //   2. Challenge timeout (inside runChallenge) — widget hangs
  // The script timeout is cleared once the script loads, so the two
  // timeouts never race against each other.
  tokenPromise = new Promise<string | null>((resolve) => {
    const scriptTimeout = setTimeout(() => resolve(null), 10_000);

    window.__onTurnstileLoad = () => {
      clearTimeout(scriptTimeout);
      // Script loaded — run first challenge. Its own timeout handles slow challenges.
      // The catch ensures a rejected challenge (e.g., render throws) still
      // resolves the outer promise with null instead of leaving it pending.
      void runChallenge(siteKey).then(resolve, () => resolve(null));
    };
  });

  // Load the Turnstile script from CDN (once)
  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__onTurnstileLoad';
  script.async = true;
  document.head.appendChild(script);
}

/**
 * Get the Turnstile token (awaits if the challenge is still in progress).
 * Returns `null` if Turnstile is not configured, failed, or timed out.
 *
 * Includes a hard 15s timeout as a last-resort safety net — even if internal
 * timeouts (setTimeout) are throttled (background tabs) or manipulated, this
 * prevents callers from hanging indefinitely.
 */
export async function getTurnstileToken(): Promise<string | null> {
  if (turnstileToken) return turnstileToken;
  if (!tokenPromise) return null; // Turnstile not initialized

  // Race the token promise against an absolute timeout. This catches
  // scenarios where internal setTimeout calls are frozen (browser throttling
  // background tabs) or never fire. The 15s budget covers script load (10s)
  // + challenge (10s) with overlap.
  const HARD_TIMEOUT_MS = 15_000;
  return Promise.race([
    tokenPromise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), HARD_TIMEOUT_MS)),
  ]);
}

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
 * Sets `tokenPromise` to a new promise that resolves with the challenge token.
 * Called on initial load and on token expiry (re-challenge without reloading the script).
 */
function runChallenge(siteKey: string): void {
  turnstileToken = null;

  const container = createTurnstileContainer();

  tokenPromise = new Promise<string | null>((resolve) => {
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
        // Token expired — clean up old container, re-challenge silently
        removeTurnstileContainer(container);
        runChallenge(siteKey);
      },
      size: 'invisible',
    });

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
 * Call once on the `/` page (new sessions). No-ops if Turnstile is not configured
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

  // Set up a promise that resolves when the first challenge completes (or times out).
  // This covers both the script-loading phase and the challenge phase.
  tokenPromise = new Promise<string | null>((resolve) => {
    window.__onTurnstileLoad = () => {
      // Script loaded — run the first challenge
      runChallenge(siteKey);
      // Forward the first challenge result
      // runChallenge() just set tokenPromise to the challenge promise, so
      // we chain on it. This is intentionally not awaited — the resolution
      // flows through the .then() callback.
      void tokenPromise!.then(resolve);
    };

    // Timeout: if the Turnstile script doesn't load in 10s, proceed without it
    setTimeout(() => resolve(null), 10_000);
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
 */
export async function getTurnstileToken(): Promise<string | null> {
  if (turnstileToken) return turnstileToken;
  if (tokenPromise) return tokenPromise;
  return null; // Turnstile not initialized
}

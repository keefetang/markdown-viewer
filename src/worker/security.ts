/**
 * Security middleware — headers, CSP nonce injection, and rate limiting helpers.
 *
 * `applySecurityHeaders` wraps any outgoing Response with hardened headers.
 * `NonceInjector` is an HTMLRewriter handler that adds CSP nonces to `<script>` tags.
 *
 * CSP allows Turnstile (challenges.cloudflare.com) and Web Analytics
 * (static.cloudflareinsights.com) by default — both are no-ops when unused.
 */

// ---------------------------------------------------------------------------
// HTMLRewriter handler — nonce injection
// ---------------------------------------------------------------------------

/**
 * Adds a `nonce` attribute to every `<script>` element in the HTML response.
 *
 * Combined with the nonce-based CSP header from `applySecurityHeaders`, this enables:
 * - Our own scripts (Vite module, analytics beacon) to execute
 * - Cloudflare Bot Management (JavaScript Detections) to inject its scripts —
 *   CF reads the nonce from the CSP header and applies it automatically
 * - `'strict-dynamic'` propagation for dynamically loaded chunks
 */
export class NonceInjector implements HTMLRewriterElementContentHandlers {
  private readonly nonce: string;

  constructor(nonce: string) {
    this.nonce = nonce;
  }

  element(el: Element): void {
    el.setAttribute('nonce', this.nonce);
  }
}

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------

/**
 * Clone a Response with security headers applied.
 *
 * @param response - The original response to wrap.
 * @param isApi - When `true`, adds `Cache-Control: no-store` and
 *   `X-Robots-Tag: noindex` (API responses should never be cached or indexed).
 * @param nonce - Per-request nonce for CSP `script-src`. Required for HTML
 *   responses so Cloudflare Bot Management (JavaScript Detections) can inject
 *   its scripts — CF reads nonces from the CSP header automatically. Must be
 *   in the HTTP header, NOT a `<meta>` tag.
 */
export function applySecurityHeaders(response: Response, isApi: boolean, nonce?: string): Response {
  const headers = new Headers(response.headers);

  // -- Universal headers --
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  // -- Content Security Policy --
  // style-src: unsafe-inline required by CodeMirror + github-markdown-css
  // img-src: https: for external images in markdown; data: for inline images
  // connect-src: self + Turnstile verification endpoint
  // frame-src: Turnstile uses an iframe for challenges
  // frame-ancestors: DENY — this site should never be embedded
  //
  // script-src (HTML responses with nonce):
  //   'nonce-{value}' — primary trust mechanism; CF edge reads this and adds
  //   the nonce to its own injected scripts (Bot Management, etc.)
  //   'strict-dynamic' — scripts loaded by a nonced script are also trusted
  //   (handles Vite dynamic imports, KaTeX lazy chunk, etc.)
  //   'self' + URL allowlists — fallback for CSP2 browsers that don't support
  //   'strict-dynamic' (CSP3 browsers ignore these when nonce is present)
  //
  // script-src (API responses without nonce):
  //   Simple 'self' — JSON responses have no scripts
  const scriptSrc = nonce
    ? `script-src 'nonce-${nonce}' 'strict-dynamic' 'self' https://challenges.cloudflare.com https://static.cloudflareinsights.com`
    : "script-src 'self' https://challenges.cloudflare.com https://static.cloudflareinsights.com";

  headers.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      scriptSrc,
      "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
      "font-src 'self' https://cdn.jsdelivr.net",
      "img-src 'self' data: https:",
      "connect-src 'self' https://challenges.cloudflare.com",
      "frame-src https://challenges.cloudflare.com",
      "frame-ancestors 'none'",
    ].join('; '),
  );

  // -- API-specific headers --
  if (isApi) {
    headers.set('Cache-Control', 'no-store');
    headers.set('X-Robots-Tag', 'noindex');
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

import { handleApi, handleCorsPreflight, handleImportUrl } from './api';
import { applySecurityHeaders, NonceInjector } from './security';
import { escapeForHtml } from './shared';
import { handleSession } from './ssr';

interface Env {
  ASSETS: Fetcher;
  SESSIONS: KVNamespace;
  // Rate limiting is optional — the Deploy to Cloudflare button may not
  // auto-provision rate limit bindings. When absent, the app functions
  // without rate limiting (Turnstile + edit tokens are the primary defenses).
  WRITE_LIMITER?: RateLimit;
  READ_LIMITER?: RateLimit;
  CF_ANALYTICS_TOKEN?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  CORS_ORIGIN?: string;
}

const SESSION_ID_RE = /^\/[A-Za-z0-9_-]{12}$/;

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      // API routes — handle CORS preflight at the router level
      if (pathname.startsWith('/api/')) {
        if (request.method === 'OPTIONS') {
          return handleCorsPreflight(env);
        }

        // URL import proxy — POST /api/import-url
        if (pathname === '/api/import-url' && request.method === 'POST') {
          const importResponse = await handleImportUrl(request, env);
          return applySecurityHeaders(importResponse, true);
        }

        const apiResponse = await handleApi(request, env);
        return applySecurityHeaders(apiResponse, true);
      }

      // robots.txt — plain text, no security headers needed
      if (pathname === '/robots.txt') {
        return handleRobotsTxt();
      }

      // Session ID route — SSR with OG tags, rendered content, and bootstrap data
      if (SESSION_ID_RE.test(pathname)) {
        const nonce = crypto.randomUUID();
        const ssrResponse = await handleSession(request, env, nonce);
        return applySecurityHeaders(ssrResponse, false, nonce);
      }

      // Everything else — serve static assets with config injection
      const nonce = crypto.randomUUID();
      const assetResponse = await handleAssets(request, env, nonce);
      return applySecurityHeaders(assetResponse, false, nonce);
    } catch (err) {
      console.error(JSON.stringify({
        message: 'unhandled error',
        error: err instanceof Error ? err.message : String(err),
        path: pathname,
      }));
      const errorRes = new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
      return applySecurityHeaders(errorRes, true);
    }
  },
} satisfies ExportedHandler<Env>;

function handleRobotsTxt(): Response {
  // Session paths are 12-char alphanumeric IDs at root level.
  // robots.txt can't pattern-match exactly, but X-Robots-Tag: noindex
  // on SSR responses is the primary indexing prevention mechanism.
  // This file supplements by disallowing /api/ and common bot targets.
  const body = [
    'User-agent: *',
    'Allow: /$',
    'Disallow: /api/',
    '',
  ].join('\n');

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

async function handleAssets(request: Request, env: Env, nonce: string): Promise<Response> {
  const response = await env.ASSETS.fetch(request);

  const contentType = response.headers.get('Content-Type') ?? '';
  if (!contentType.includes('text/html')) {
    return response;
  }

  // Inject runtime config into HTML responses via HTMLRewriter.
  // NonceInjector adds `nonce` to ALL <script> tags (existing + appended),
  // enabling CSP nonce-based trust. Cloudflare's edge reads the nonce from
  // our CSP header and applies it to its own injected scripts too.
  let rewriter = new HTMLRewriter()
    .on('script', new NonceInjector(nonce));

  if (env.CF_ANALYTICS_TOKEN) {
    const token = escapeForHtml(env.CF_ANALYTICS_TOKEN);
    rewriter = rewriter.on('body', {
      element(el) {
        el.append(
          `<script nonce="${nonce}" defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"${token}"}'></script>`,
          { html: true },
        );
      },
    });
  }

  if (env.TURNSTILE_SITE_KEY) {
    const siteKey = escapeForHtml(env.TURNSTILE_SITE_KEY);
    rewriter = rewriter.on('head', {
      element(el) {
        el.append(
          `<script nonce="${nonce}">window.__TURNSTILE_KEY__="${siteKey}";</script>`,
          { html: true },
        );
      },
    });
  }

  return rewriter.transform(response);
}

import { handleApi, handleCorsPreflight, handleImportUrl } from './api';
import { getIndexHtml, getIndexMarkdown } from './index-content';
import { handleMcp } from './mcp';
import { applySecurityHeaders, NonceInjector } from './security';
import { extractRawFrontmatter } from '../shared/frontmatter';
import { escapeForHtml, timingSafeEqual, sessionHeaders, computeContentHash, checkIfNoneMatch, sliceContent } from './shared';
import type { SessionMetadata } from './shared';
import { handleSession } from './ssr';
import { renderMarkdown, extractTitle } from '../shared/markdown';
import { buildHtmlDocument } from '../shared/html-document';

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

// ---- MCP Server Card (EXPERIMENTAL) ----
// Based on draft SEP-2127 (MCP Server Cards). This standard is not yet
// finalized. Revisit when SEP-2127 is adopted or superseded.

/** Build the MCP server card dynamically from the request origin. */
function buildMcpServerCard(origin: string): string {
  return JSON.stringify({
    $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
    name: 'markdown-viewer',
    version: '1.0.0',
    title: 'Markdown Viewer',
    description:
      'Privacy-first markdown document platform. Create, read, update, and share markdown documents via unique URLs. Supports YAML frontmatter conventions, partial read/write, batch operations, and edit history.',
    websiteUrl: origin,
    remotes: [
      {
        type: 'streamable-http',
        url: `${origin}/mcp`,
        supportedProtocolVersions: ['2025-03-26'],
        authentication: {
          required: false,
        },
      },
    ],
    capabilities: {
      tools: {},
    },
  }, null, 2);
}

// ---- Content Negotiation ----

function wantsMarkdown(request: Request): boolean {
  const accept = request.headers.get('Accept') || '';
  // Match explicit text/markdown requests (CLI tools, programmatic clients).
  // Exclude browsers — they always send text/html in their Accept header.
  return accept.includes('text/markdown') && !accept.includes('text/html');
}

/**
 * Return raw markdown for a session via content negotiation.
 * Public sessions are readable by anyone — the content is already visible
 * via the UI. Private sessions require a valid edit token. Never exposes editToken.
 */
async function handleMarkdownContent(request: Request, env: Env, sessionId: string): Promise<Response> {
  const url = new URL(request.url);

  // --- Validate offset/limit/fields query params ---
  const offsetStr = url.searchParams.get('offset');
  const limitStr = url.searchParams.get('limit');
  const fields = url.searchParams.get('fields');

  let offset: number | undefined;
  let limit: number | undefined;

  if (offsetStr !== null) {
    const n = Number(offsetStr);
    if (!Number.isInteger(n) || n < 1) {
      return new Response('offset must be a positive integer', {
        status: 400,
        headers: { 'Content-Type': 'text/plain' },
      });
    }
    offset = n;
  }

  if (limitStr !== null) {
    const n = Number(limitStr);
    if (!Number.isInteger(n) || n < 1) {
      return new Response('limit must be a positive integer', {
        status: 400,
        headers: { 'Content-Type': 'text/plain' },
      });
    }
    limit = n;
  }

  if (fields !== null && fields !== 'frontmatter') {
    return new Response('fields must be "frontmatter"', {
      status: 400,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  const { value: content, metadata } =
    await env.SESSIONS.getWithMetadata<SessionMetadata>(sessionId);

  if (content === null || metadata === null) {
    return new Response('Not found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  // Private sessions require a valid edit token — return 404 to avoid
  // revealing that the session exists.
  if (metadata.private) {
    const editTokenHeader = request.headers.get('X-Edit-Token');
    if (!editTokenHeader || !timingSafeEqual(editTokenHeader, metadata.editToken)) {
      return new Response('Not found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain' },
      });
    }
  }

  // Conditional retrieval — 304 when client already has current version.
  if (checkIfNoneMatch(request, metadata.updatedAt)) {
    return new Response(null, {
      status: 304,
      headers: sessionHeaders(metadata),
    });
  }

  // Backward compat: compute hash on-the-fly for old documents without contentHash.
  const contentHash = metadata.contentHash ?? await computeContentHash(content);

  // --- fields=frontmatter: return raw YAML frontmatter block as text ---
  if (fields === 'frontmatter') {
    const rawBlock = extractRawFrontmatter(content);
    return new Response(rawBlock ?? '', {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        ...sessionHeaders(metadata, contentHash),
      },
    });
  }

  // --- Line-range slicing for text/markdown responses ---
  const { sliced: responseContent } = sliceContent(content, offset, limit);

  // X-Robots-Tag and Cache-Control added by applySecurityHeaders (isApi=true)
  return new Response(responseContent, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      ...sessionHeaders(metadata, contentHash),
    },
  });
}

/**
 * Return rendered HTML for a session via ?format=html.
 * Produces the same standalone document as the browser's Export → HTML,
 * with inline styles for light + dark mode. No external dependencies.
 */
async function handleHtmlContent(request: Request, env: Env, sessionId: string): Promise<Response> {
  const { value: content, metadata } =
    await env.SESSIONS.getWithMetadata<SessionMetadata>(sessionId);

  if (content === null || metadata === null) {
    return new Response('Not found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  if (metadata.private) {
    const editTokenHeader = request.headers.get('X-Edit-Token');
    if (!editTokenHeader || !timingSafeEqual(editTokenHeader, metadata.editToken)) {
      return new Response('Not found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain' },
      });
    }
  }

  // Conditional retrieval — 304 when client already has current version.
  if (checkIfNoneMatch(request, metadata.updatedAt)) {
    return new Response(null, {
      status: 304,
      headers: sessionHeaders(metadata),
    });
  }

  // Backward compat: compute hash on-the-fly for old documents without contentHash.
  const contentHash = metadata.contentHash ?? await computeContentHash(content);

  const rendered = renderMarkdown(content);
  const title = extractTitle(content) || 'Untitled';
  const html = buildHtmlDocument(rendered, title);

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Robots-Tag': 'noindex',
      ...sessionHeaders(metadata, contentHash),
    },
  });
}

// ---- Router ----

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      // EXPERIMENTAL: MCP Server Card (draft SEP-2127).
      // Dynamic: derives URLs from request origin so it works on any deployment.
      if (pathname === '/.well-known/mcp-server-card') {
        const res = applySecurityHeaders(
          new Response(buildMcpServerCard(url.origin), {
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            },
          }),
          true,
        );
        // Override api-default headers: this is a static discovery endpoint,
        // not a dynamic API — it should be cacheable and indexable.
        res.headers.set('Cache-Control', 'public, max-age=86400');
        res.headers.delete('X-Robots-Tag');
        return res;
      }

      // MCP server — Streamable HTTP transport for AI agent tool access.
      // Match exact path or path with trailing segments (e.g. /mcp/sse).
      // Rate limit POST requests (tool calls) using the write limiter.
      if (pathname === '/mcp' || pathname.startsWith('/mcp/')) {
        if (request.method === 'POST' && env.WRITE_LIMITER) {
          const ip = request.headers.get('cf-connecting-ip') || 'unknown';
          const { success } = await env.WRITE_LIMITER.limit({ key: ip });
          if (!success) {
            return applySecurityHeaders(
              new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
                status: 429,
                headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
              }),
              true,
            );
          }
        }
        const mcpResponse = await handleMcp(request, env, ctx);
        return applySecurityHeaders(mcpResponse, true);
      }

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

        const apiResponse = await handleApi(request, env, ctx);
        return applySecurityHeaders(apiResponse, true);
      }

      // robots.txt — plain text, no security headers needed
      if (pathname === '/robots.txt') {
        return handleRobotsTxt();
      }

      // Content negotiation — Accept: text/markdown returns raw content,
      // ?format=html returns rendered standalone HTML.
      // Wrapped with applySecurityHeaders (isApi=true) for consistent
      // security posture (HSTS, nosniff, noindex, etc.).
      const format = url.searchParams.get('format');

      if (wantsMarkdown(request) || format === 'md') {
        if (pathname === '/') {
          const mdResponse = new Response(getIndexMarkdown(), {
            headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
          });
          return applySecurityHeaders(mdResponse, true);
        }
        if (SESSION_ID_RE.test(pathname)) {
          const mdResponse = await handleMarkdownContent(request, env, pathname.slice(1));
          return applySecurityHeaders(mdResponse, true);
        }
      }

      // ?format=html — rendered standalone HTML (same as browser Export → HTML)
      if (format === 'html' && SESSION_ID_RE.test(pathname)) {
        const htmlResponse = await handleHtmlContent(request, env, pathname.slice(1));
        return applySecurityHeaders(htmlResponse, true);
      }

      // Session ID route — SSR with OG tags, rendered content, and bootstrap data
      if (SESSION_ID_RE.test(pathname)) {
        const nonce = crypto.randomUUID();
        const ssrResponse = await handleSession(request, env, nonce);
        return applySecurityHeaders(ssrResponse, false, nonce);
      }

      // Everything else — serve static assets with config injection.
      // For `/`, also injects SEO content and OG meta tags.
      const nonce = crypto.randomUUID();
      const assetResponse = await handleAssets(request, env, url, nonce);
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
  // Only the front page is indexable. Everything else — session content,
  // API, assets — is disallowed. X-Robots-Tag: noindex on SSR responses
  // is the belt; this is the suspenders.
  const body = [
    'User-agent: *',
    'Allow: /$',
    'Disallow: /',
    '',
  ].join('\n');

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

// ---- Static Assets + SEO ----

async function handleAssets(request: Request, env: Env, url: URL, nonce: string): Promise<Response> {
  const response = await env.ASSETS.fetch(request);

  const contentType = response.headers.get('Content-Type') ?? '';
  if (!contentType.includes('text/html')) {
    return response;
  }

  const isIndex = url.pathname === '/';

  // Inject runtime config into HTML responses via HTMLRewriter.
  // NonceInjector adds `nonce` to ALL <script> tags (existing + appended),
  // enabling CSP nonce-based trust. Cloudflare's edge reads the nonce from
  // our CSP header and applies it to its own injected scripts too.
  let rewriter = new HTMLRewriter()
    .on('script', new NonceInjector(nonce));

  // Index page — inject OG meta tags and SEO content for crawlers.
  // #content { display: none } in the CSS bundle prevents flash for browser
  // users; crawlers parsing raw HTML (no CSS) see the content.
  if (isIndex) {
    const indexUrl = escapeForHtml(url.origin + '/');
    rewriter = rewriter
      .on('head', {
        element(el) {
          const tags = [
            `<meta property="og:title" content="Markdown Viewer" />`,
            `<meta property="og:description" content="A fast, privacy-first markdown pad. Write, preview, and share markdown via unique URLs." />`,
            `<meta property="og:type" content="website" />`,
            `<meta property="og:url" content="${indexUrl}" />`,
            `<meta name="twitter:card" content="summary" />`,
          ].join('\n    ');
          el.append(`\n    ${tags}`, { html: true });
        },
      })
      .on('div#content', {
        element(el) {
          el.setInnerContent(`\n      ${getIndexHtml().replace(/\n/g, '\n      ')}\n    `, { html: true });
        },
      });
  }

  if (env.CF_ANALYTICS_TOKEN) {
    const token = escapeForHtml(env.CF_ANALYTICS_TOKEN);
    rewriter = rewriter.on('body', {
      element(el) {
        el.append(
          `\n    <script nonce="${nonce}" defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"${token}"}'></script>\n  `,
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
          `\n    <script nonce="${nonce}">window.__TURNSTILE_KEY__="${siteKey}";</script>\n  `,
          { html: true },
        );
      },
    });
  }

  return rewriter.transform(response);
}

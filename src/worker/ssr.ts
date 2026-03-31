/**
 * Server-side rendering for `/:id` session routes.
 *
 * Fetches the session from KV, renders markdown to HTML, and uses
 * HTMLRewriter to inject OG meta tags, rendered content, and bootstrap
 * data into the SPA shell. Crawlers see full content; the SPA boots
 * from injected data without a redundant API fetch.
 */

import { renderMarkdown, extractTitle, stripInlineMarkdown } from '../shared/markdown';
import { NonceInjector } from './security';
import { escapeForHtml } from './shared';
import type { SessionMetadata } from './shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Env {
  ASSETS: Fetcher;
  SESSIONS: KVNamespace;
  CF_ANALYTICS_TOKEN?: string;
  TURNSTILE_SITE_KEY?: string;
}

interface BootstrapData {
  id: string;
  content: string;
  metadata: {
    createdAt: number;
    updatedAt: number;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape a string for safe embedding in an HTML text node (not attributes). */
function escapeText(value: string): string {
  return value.replace(/[&<>]/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      default: return ch;
    }
  });
}

/**
 * Extract a plain-text description (~160 chars) from markdown content.
 * Strips common markdown syntax for a rough approximation.
 */
function extractDescription(markdown: string): string {
  const plain = stripInlineMarkdown(
    markdown
      .replace(/^#+\s+/gm, '')       // headings
      .replace(/^[-*>]\s+/gm, '')    // list items, blockquotes
      .replace(/\n+/g, ' '),         // newlines to spaces
  );
  return plain.substring(0, 160);
}

// ---------------------------------------------------------------------------
// HTMLRewriter element handlers
// ---------------------------------------------------------------------------

/** Replaces the inner text of a <title> element. */
class TitleHandler implements HTMLRewriterElementContentHandlers {
  private readonly title: string;
  private replaced = false;

  constructor(title: string) {
    this.title = title;
  }

  text(text: Text): void {
    if (!this.replaced) {
      text.replace(escapeText(this.title));
      this.replaced = true;
    } else {
      text.remove();
    }
  }
}

/** Appends OG meta tags to <head>. */
class HeadHandler implements HTMLRewriterElementContentHandlers {
  private readonly tags: string;

  constructor(tags: string) {
    this.tags = tags;
  }

  element(el: Element): void {
    el.append(this.tags, { html: true });
  }
}

/** Injects rendered HTML into the #content div. */
class ContentHandler implements HTMLRewriterElementContentHandlers {
  private readonly html: string;

  constructor(html: string) {
    this.html = html;
  }

  element(el: Element): void {
    el.append(`<div class="markdown-body">${this.html}</div>`, { html: true });
  }
}

/** Appends scripts/data before </body>. */
class BodyHandler implements HTMLRewriterElementContentHandlers {
  private readonly snippets: string[];

  constructor(snippets: string[]) {
    this.snippets = snippets;
  }

  element(el: Element): void {
    for (const snippet of this.snippets) {
      el.append(snippet, { html: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Main SSR handler
// ---------------------------------------------------------------------------

/**
 * Handle a `/:id` session route with server-side rendering.
 *
 * - Fetches session from KV
 * - Not found → 302 redirect to `/`
 * - Found → renders markdown, injects OG tags + content + bootstrap data
 *   into the SPA shell via HTMLRewriter
 *
 * @param nonce - Per-request CSP nonce for script tags.
 */
export async function handleSession(request: Request, env: Env, nonce: string): Promise<Response> {
  const url = new URL(request.url);
  const id = url.pathname.slice(1); // strip leading `/`

  // Fetch session from KV.
  // On KV error: serve the bare SPA shell (no bootstrap data). The client
  // will retry via API fetch and show an error in the UI — better than a
  // raw JSON 500 response.
  // On 404: redirect to `/`.
  let content: string | null = null;
  let metadata: SessionMetadata | null = null;
  let kvError = false;
  try {
    const result = await env.SESSIONS.getWithMetadata<SessionMetadata>(id);
    content = result.value;
    metadata = result.metadata;
  } catch {
    kvError = true;
  }

  if (!kvError && (content === null || metadata === null)) {
    // Session genuinely not found — redirect to home
    return Response.redirect(`${url.origin}/`, 302);
  }

  if (kvError) {
    // KV unavailable — serve the SPA shell without SSR content.
    // The client boots, sees it's on /:id, tries the API, and handles the error.
    const shellResponse = await env.ASSETS.fetch(new Request(`${url.origin}/index.html`));
    return new HTMLRewriter()
      .on('script', new NonceInjector(nonce))
      .transform(shellResponse);
  }

  // Render markdown
  const renderedHtml = renderMarkdown(content);

  // Extract SEO data
  const title = extractTitle(content);
  const description = extractDescription(content);
  const fullUrl = url.href;

  // Build bootstrap data (NO editToken — tokens come from URL hash or localStorage)
  const bootstrapData: BootstrapData = {
    id,
    content,
    metadata: {
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
    },
  };

  // CRITICAL: Escape ALL `<` to prevent </script> injection attacks
  const safeJson = JSON.stringify(bootstrapData).replace(/</g, '\\u003c');

  // Build OG meta tags
  const escapedTitle = escapeForHtml(title);
  const escapedDesc = escapeForHtml(description);
  const escapedUrl = escapeForHtml(fullUrl);

  // Build head tags: OG meta + Turnstile site key (matches handleAssets placement in <head>)
  const headTags: string[] = [
    `<meta property="og:title" content="${escapedTitle}" />`,
    `<meta property="og:description" content="${escapedDesc}" />`,
    `<meta property="og:type" content="article" />`,
    `<meta property="og:url" content="${escapedUrl}" />`,
    `<meta name="twitter:card" content="summary" />`,
    `<meta name="twitter:title" content="${escapedTitle}" />`,
    `<meta name="twitter:description" content="${escapedDesc}" />`,
  ];

  if (env.TURNSTILE_SITE_KEY) {
    const siteKey = escapeForHtml(env.TURNSTILE_SITE_KEY);
    headTags.push(`<script nonce="${nonce}">window.__TURNSTILE_KEY__="${siteKey}";</script>`);
  }

  // Build body snippets: bootstrap data + optional analytics beacon.
  // Nonces are added inline here AND via NonceInjector on existing <script> tags.
  const bodySnippets: string[] = [
    `<script nonce="${nonce}" type="application/json" id="__DATA__">${safeJson}</script>`,
  ];

  if (env.CF_ANALYTICS_TOKEN) {
    const token = escapeForHtml(env.CF_ANALYTICS_TOKEN);
    bodySnippets.push(
      `<script nonce="${nonce}" defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"${token}"}'></script>`,
    );
  }

  // Fetch the SPA shell from static assets
  const shellResponse = await env.ASSETS.fetch(new Request(`${url.origin}/index.html`));

  // Apply HTMLRewriter transformations.
  // NonceInjector adds `nonce` to ALL <script> tags (existing Vite module scripts
  // in the SPA shell). Appended scripts already have nonces inline above.
  const pageTitle = `${title} \u2014 Markdown Viewer`;
  const rewriter = new HTMLRewriter()
    .on('script', new NonceInjector(nonce))
    .on('title', new TitleHandler(pageTitle))
    .on('head', new HeadHandler(headTags.join('\n')))
    .on('div#content', new ContentHandler(renderedHtml))
    .on('body', new BodyHandler(bodySnippets));

  const response = rewriter.transform(shellResponse);

  // Add headers — prevent search indexing of user content
  const headers = new Headers(response.headers);
  headers.set('X-Robots-Tag', 'noindex');
  headers.set('Content-Type', 'text/html; charset=utf-8');

  return new Response(response.body, {
    status: response.status,
    headers,
  });
}

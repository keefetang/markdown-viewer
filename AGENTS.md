# Markdown Viewer — Agent Guide

## What This Project Is

A Cloudflare-native markdown pad. Write markdown, see a live rendered preview side by side, share via a unique URL. Distinguishes itself through speed, interface craft, and deployment simplicity — not feature count.

**Stack:** Svelte 5 (runes) + Vite + Cloudflare Workers + Static Assets + KV.

**Audience:** Open-source, deployable to any Cloudflare account via one-click deploy button. Privacy-first: no cookies, no personal data, no tracking.

## Architecture

Single Cloudflare Worker project with three responsibilities:

```
/assets/*  →  CDN (no Worker invocation)
/*         →  Worker
               ├── /         → ASSETS.fetch() + HTMLRewriter (OG tags + SEO content + config)
               ├── /api/*    → REST API (sessions, batch, history, import-url)
               ├── /mcp      → MCP Server (13 tools, Streamable HTTP transport)
               ├── /robots.txt → Static text
               └── /:id      → SSR via HTMLRewriter (OG tags + rendered content + bootstrap data)
```

**Hybrid rendering:** `/:id` routes are server-rendered for crawlers/AI agents (OG meta tags, visible HTML). The SPA boots from injected bootstrap data without a redundant API fetch. The root `/` serves the SPA shell with OG tags, hidden SEO content (feature description in `#content`), and runtime config injected via HTMLRewriter. Private sessions get the bare SPA shell — no SSR, no OG tags, no bootstrap data (the edit token lives in the URL hash which never reaches the server).

**Content negotiation:** Both `/` and `/:id` check the `Accept` header. When `Accept: text/markdown` is present (and `text/html` is absent), `/` returns a markdown description of the tool and `/:id` returns the raw markdown content. Private sessions require `X-Edit-Token` for content negotiation too. This enables CLI tools (`curl -H 'Accept: text/markdown'`) and AI agents to fetch content without parsing HTML.

**Static assets** (Vite hashed output in `dist/`) are served directly from CDN — the Worker never touches them.

## Project Structure

```
src/
├── worker/                 # Cloudflare Worker (server)
│   ├── index.ts            # Router: API, SSR, assets, CORS, error handling
│   ├── api.ts              # REST API: GET, PUT, PATCH, DELETE, batch, history + POST import-url
│   ├── sessions.ts         # Shared business logic (getSession, putSession, patchSession, etc.)
│   ├── mcp.ts              # MCP Server (13 tools via createMcpHandler)
│   ├── ssr.ts              # HTMLRewriter SSR for /:id routes
│   ├── index-content.ts    # Static HTML + markdown content for index page SEO + content negotiation
│   ├── security.ts         # Security headers middleware + CSP nonce injection
│   └── shared.ts           # Shared types, helpers (sessionHeaders, conditional checks, history)
├── shared/
│   ├── escape.ts           # Isomorphic HTML escape utilities (browser + Worker)
│   ├── frontmatter.ts      # YAML frontmatter parse/update/serialize (isomorphic)
│   ├── html-document.ts    # Standalone HTML document builder (shared between client export + Worker)
│   └── markdown.ts         # markdown-it config + extractTitle (used by BOTH client and Worker)
├── app/                    # Svelte 5 SPA (client)
│   ├── main.ts             # Entry point + theme init
│   ├── App.svelte          # Orchestrator: routing, state, auto-save, actions
│   ├── components/
│   │   ├── Editor.svelte   # CodeMirror 6 wrapper
│   │   ├── Preview.svelte  # Rendered markdown with DOMPurify
│   │   ├── SplitPane.svelte # Resizable split layout
│   │   └── Toolbar.svelte  # All actions, desktop + mobile layouts
│   ├── lib/
│   │   ├── api.ts          # Fetch wrapper for session API + URL import
│   │   ├── autosave.ts     # Debounced save with state machine
│   │   ├── tokens.ts       # Edit token localStorage management
│   │   ├── turnstile.ts    # Optional Turnstile bot protection
│   │   ├── stats.ts        # Word count, char count, read time
│   │   ├── export.ts       # Download md/html, print pdf, copy rendered
│   │   ├── shortcuts.ts    # Keyboard shortcut bindings
│   │   ├── placeholder.ts  # Default placeholder markdown content
│   │   └── types.ts        # Shared TypeScript types
│   └── styles/
│       ├── global.css      # Design system: tokens, reset, light/dark themes
│       ├── editor.css      # CodeMirror theme overrides
│       └── preview.css     # github-markdown-css + hljs + design token overrides
├── index.html              # SPA shell (Vite entry, has #content and #app divs)
└── types.d.ts              # Module declarations (svelte, untyped packages)
```

## Build / Lint / Test Commands

```bash
npm run dev          # Local dev server (wrangler dev, http://localhost:8787)
npm run build        # Vite build → dist/
npm run deploy       # wrangler deploy (KV auto-provisioned on first deploy)
npm run deploy:prod  # Deploy with custom domain (requires .deploy/wrangler.jsonc — see template)
npm run cf-typegen   # Regenerate Worker type bindings

# Type checking (must pass with zero errors AND zero warnings)
npx svelte-check --tsconfig ./tsconfig.json
npx tsc --noEmit     # Worker-only check (faster, skips .svelte files)

# No test framework configured yet. Pure functions in lib/ are testable:
#   stats.ts, tokens.ts, shortcuts.ts, export.ts (extractTitle, computeStats, etc.)
```

Build must produce: initial JS < 175kb gzipped. Verify with `npm run build`. KaTeX lazy chunk (~800kb) is expected and excluded from the budget via `chunkSizeWarningLimit: 900` in vite.config.ts.

## Code Style

### TypeScript
- **Strict mode** — `strict: true`, `verbatimModuleSyntax: true`, `isolatedModules: true` in tsconfig.json.
- **Target:** ES2022. Module resolution: `bundler`.
- **Use `import type` for type-only imports** — enforced by `verbatimModuleSyntax`.
- **No `any`** — use `unknown` and narrow, or define proper interfaces.
- **Worker files** declare their own narrowed `Env` interface with only the bindings they need (principle of least privilege). The full `Env` is in `src/worker/index.ts`.

### Svelte 5 Runes Only
- **Use** `$state`, `$derived`, `$effect`, `$props`, `$bindable`.
- **Do NOT use** Svelte 4 syntax: no `$:` reactive statements, no `export let` for props.
- **Props** use the `interface Props {}` pattern with `let { prop = default } = $props<Props>()`.
- **Component methods** exposed via `export function` (not stores or bindings).

### Imports & Module Organization
- Worker files: section with `// ---- Section Name ----` banner comments.
- Svelte files: `<script lang="ts">` with imports grouped: svelte → libraries → local components → local lib → types.
- CSS imports in `.svelte` via `import './styles/foo.css'` (side-effect imports).
- Shared code (`src/shared/`) must never use browser-only APIs (`document`, `window`, `localStorage`).

### Naming Conventions
- **Files:** lowercase-kebab for `.ts`/`.css`, PascalCase for `.svelte` components.
- **Interfaces/Types:** PascalCase (`SessionMetadata`, `ContentStats`, `ViewMode`).
- **Constants:** UPPER_SNAKE for module-level (`MAX_CONTENT_LENGTH`, `EXPIRATION_TTL`, `SESSION_ID_RE`).
- **Functions:** camelCase. Prefix handlers with `handle` (`handleApi`, `handleSession`).
- **CSS tokens:** domain-specific names (`--ink`, `--paper`, `--pencil`, `--margin-note`). Never generic (`--gray-700`, `--bg-primary`). See `.interface-design/system.md`.

### Error Handling
- **Worker API:** Global try/catch in `handleApi`. All errors return `{ error: string }` JSON — never stack traces, binding names, or internal details.
- **Client `localStorage`:** Every access wrapped in try/catch (may be unavailable).
- **Client API calls:** Errors surfaced via `SaveState` (`'error'`) and toast notifications, never `alert()`.
- **Graceful degradation:** Turnstile failure → skip (rate limiting fallback). KaTeX load failure → raw math text. Clipboard API failure → fallback to `writeText`.

### CSS / Styling
- **All values via design tokens** from `global.css`. No hardcoded hex colors or pixel values outside `:root`.
- **Light + dark** via `@media (prefers-color-scheme: dark)` on `:root` (system preference) AND `[data-theme="dark"]`/`[data-theme="light"]` on `:root` (manual override). 3-state toggle: System / Light / Dark. Components just use `var(--token)` — theming is automatic.
- **Borders-only depth** — no box shadows (exception: toast notifications).
- **Scoped styles** in `.svelte` files. Use `:global()` only for dynamically injected HTML (preview, code highlighting).
- **`color-mix()`** for derived opacity colors instead of hardcoded `rgba`.

## Security Rules (Non-Negotiable)

- Never set `html: true` on markdown-it — primary XSS defense.
- Never expose `editToken` in GET, PATCH responses, or SSR bootstrap data.
- Always escape `<` to `\u003c` when embedding JSON in `<script>` tags.
- Always `DOMPurify.sanitize()` before `{@html}` on the client (Workers lack DOM APIs — rely on markdown-it + CSP server-side).
- Always use `crypto.subtle.timingSafeEqual()` for edit token comparison — including in PATCH handlers and MCP tools.
- CORS `Access-Control-Allow-Headers` must include `X-Edit-Token`.
- Always add `nonce` attribute to `<script>` tags injected via HTMLRewriter — CSP uses per-request nonces (`crypto.randomUUID()`). Cloudflare Bot Management reads the nonce from the CSP header and adds it to its own injected scripts.
- YAML frontmatter parsing must use `schema: 'core'` (YAML 1.2 core — accepts unquoted strings, no code execution in JS) — untrusted input.
- MCP tools that write must enforce the same edit token checks as REST endpoints — no privilege escalation.

## Data Model

### Sessions
```
KV key:       nanoid(12) — URL-safe, cryptographically random
KV value:     raw markdown string (max 512 KB)
KV metadata:  { createdAt: number, updatedAt: number, editToken: string, private?: boolean, ttl?: number, contentHash?: string }
KV TTL:       7,776,000 seconds (90 days) for browser sessions, 2,592,000 (30 days) for agent sessions — reset on every save
```

`private` is backward-compatible: absent or `false` = public session. `ttl` is set at creation and preserved on update. `contentHash` is a SHA-256 hex digest (64-char lowercase hex) computed on every write; absent on older documents (computed on-the-fly during reads without writing back).

### Secondary KV Keys
```
KV key:       {id}:history — changelog entries for a session
KV value:     JSON array of { ts: number, summary: string, bytes: number }
KV TTL:       same as primary key (reset on each history append)

KV key:       {id}:links — outbound internal links from a session
KV value:     JSON array of target session IDs (strings)
KV TTL:       same as primary key (reset on each content write)

KV key:       {id}:backlinks — inbound links to a session from other sessions
KV value:     JSON array of source session IDs (strings)
KV TTL:       same as target session's primary key
```

History capped at 100 entries. Backlinks capped at 500 entries. All secondary keys deleted when the primary session is deleted.

### API Surface
| Method | Path | Auth | Behavior |
|--------|------|------|----------|
| GET | `/api/sessions/:id` | Conditional | Read session. Supports `offset`/`limit` (line-range), `fields=frontmatter` (metadata-only). Returns `{ id, content, metadata, private, frontmatter, etag, contentHash, expiresAt, totalLines }`. Conditional: `If-None-Match` → 304, `If-Modified-Since` → 304. Never returns editToken. |
| PUT | `/api/sessions/:id` | Conditional | Accepts `application/json` or `text/markdown`. No token + new → CREATE (201). Valid token + exists → UPDATE (200). Supports `If-Match` (412 on mismatch), `If-None-Match: *` (412 if exists). Optional `changeSummary` creates history entry. |
| PATCH | `/api/sessions/:id` | `X-Edit-Token` | Partial write. Body: `{ operations: [...], changeSummary? }`. Operations: `append`, `insertAfter`, `replaceLine`, `updateFrontmatter`. All-or-nothing. Supports `If-Match`. |
| DELETE | `/api/sessions/:id` | `X-Edit-Token` | Deletes session + history + link tracking. 403 without valid token. |
| GET | `/api/sessions/:id/history` | Conditional | Returns `{ id, history: [...] }` changelog. Private sessions require token. |
| GET | `/api/sessions/:id/backlinks` | Conditional | Returns `{ id, backlinks: [...] }` list of documents that link to this session. Private sessions require token. |
| POST | `/api/sessions/batch/read` | Per-document | Read multiple documents. Body: `{ ids, tokens?, etags?, fields?, offset?, limit? }`. Max 20. |
| POST | `/api/sessions/batch/update` | Per-document | Update multiple documents. Body: `{ updates: [{ id, editToken, content, ... }] }`. Max 10. |
| POST | `/api/import-url` | Rate limited | Secure URL proxy. Body: `{ url }`. Returns `{ content }`. HTTPS only, 512 KB limit. |
| OPTIONS | `/api/*` | None | CORS preflight. Includes `X-Edit-Token, X-Private, If-Match, If-None-Match, If-Modified-Since, X-Change-Summary`. |

### MCP Server
| Path | Transport | Tools |
|------|-----------|-------|
| `/mcp` | Streamable HTTP (stateless, no DO) | 13 tools: create_document, read_document, update_document, delete_document, import_url, append_to_document, insert_after_line, replace_line, update_frontmatter, batch_read_documents, batch_update_documents, get_document_history, get_backlinks |

MCP tool descriptions embed YAML frontmatter conventions (`title`, `status`, `sources`, `supersedes`) — agents discover these at connection time.

### MCP Discovery (Experimental)
`GET /.well-known/mcp-server-card` returns a JSON server card per [draft SEP-2127](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2127). This is an **experimental** feature based on an unfinalized standard — revisit when SEP-2127 is adopted or superseded. Static JSON, 24-hour cache, CORS-enabled.

ID validation on all endpoints: `/^[A-Za-z0-9_-]{12}$/`. Reject 400 if invalid.

### localStorage Keys
| Key | Purpose |
|-----|---------|
| `markdown-viewer-theme` | Theme preference (light/dark/system) |
| `markdown-viewer-line-wrap` | Word wrap toggle. Stored as `"true"`/`"false"`, defaults to `true`. |
| `md-token:{id}` | Per-session edit tokens (one per session ID) |

### URL Import Security (11-step validation chain)
The `POST /api/import-url` endpoint is the most security-sensitive feature. It acts as an HTTP proxy and must validate:
1. Scheme: HTTPS only
2. Credentials: reject `user:pass@host` URLs
3. Hostname: block localhost, RFC1918 private IPs, cloud metadata (`169.254.169.254`), IPv6 loopback/link-local, IPv4-mapped IPv6
4. Redirects: manual handling (`redirect: 'manual'`), max 3 hops, re-validate steps 1-3 on every redirect destination
5. Timeout: 5s total via `AbortSignal.timeout()`
6. Content-Type: allow `text/*` (except `text/html`), reject HTML/JSON/binary with helpful errors
7. Body size: streaming read with 512 KB limit
8. UTF-8: `TextDecoder('utf-8', { fatal: true })` rejects invalid bytes
9. Null bytes: rejects binary disguised as text
10. Response isolation: return only `{ content }`, never forward upstream headers
11. Fresh Response: Worker constructs its own response — no upstream data leakage

Sources: OWASP SSRF Prevention Cheat Sheet, PortSwigger URL validation bypass research, Assetnote Blind SSRF Chains.

## Performance Constraints

- **Initial bundle target: < 175kb gzipped** (verify with `npm run build` — JS + CSS combined)
- **KaTeX is lazy-loaded** — NOT in the initial bundle. Two markdown-it instances: `md` (base, always available) and `mdWithKatex` (created on demand after `await import('katex')`)
- **highlight.js** — only 11 core languages registered (js, ts, python, bash, json, html, css, go, rust, sql, yaml). Rest lazy-loaded.
- Vite chunk size warning limit set to 900kb (KaTeX lazy chunk is ~800kb, intentional)

## Environment Variables (all optional)

| Variable | Purpose | Where Set |
|----------|---------|-----------|
| `CF_ANALYTICS_TOKEN` | Cloudflare Web Analytics (cookie-free) | wrangler secret / dashboard |
| `TURNSTILE_SITE_KEY` | Bot protection — public site key | wrangler var / dashboard |
| `TURNSTILE_SECRET_KEY` | Bot protection — secret key | wrangler secret / dashboard |
| `CORS_ORIGIN` | Restrict API to specific origin (defaults to `*`) | wrangler var / dashboard |

Without any configuration, the app works fully — protected by rate limiting only.

## Domain Skills

When working on this project, load these skills as relevant:
- `cloudflare` — platform knowledge, product selection
- `wrangler` — CLI commands, config format
- `workers-best-practices` — Worker patterns, anti-patterns
- `typescript` — type conventions
- `interface-design` — UI craft, design system, component patterns
- `web-perf` — Lighthouse, Core Web Vitals measurement

A reference skill for the platform's MCP server is included at `.opencode/skills/markdown-pad/SKILL.md` — covers frontmatter conventions, trust model, secrets handling, and agent workflows. Load it when using the MCP tools to interact with the platform.

# Markdown Viewer

A markdown pad that's fast, private, and yours to deploy. No accounts, no cookies, no tracking — just write markdown and see a live preview. Share the URL, and anyone can read it. Deploy your own instance to Cloudflare in one click.

**[Try the live demo →](https://markdown.pentagram.me)**

<!-- TODO: Add screenshot showing split view with editor and rendered preview -->

> **Private by default.** No cookies. No user accounts. No personal data collected or stored. Sessions contain only your markdown content and timestamps. Nothing else.

## ✨ Features

### Editor

- **Split-pane editing** — CodeMirror 6 with markdown syntax highlighting and resizable divider
- **Three view modes** — Editor only, Split (side-by-side), or Preview only
- **Synchronized scrolling** — Editor and preview scroll together (toggle-able)
- **Word wrap** — Toggle-able, on by default, persisted across sessions
- **Search & replace** — Cmd+F / Ctrl+F with match highlighting
- **Content stats** — Live word count, character count, and estimated read time

### Markdown

- **GFM support** — Tables, task lists, strikethrough
- **Syntax-highlighted code blocks** — 11 core languages via highlight.js
- **YAML frontmatter** — rendered as a syntax-highlighted block, parsed and returned as structured metadata via API
- **Heading anchors** — deep-link to any section with `#slug` URL fragments
- **Copy-to-clipboard** — code blocks have a copy button on hover
- **KaTeX math** — LaTeX math rendering, lazy-loaded only when math is detected
- **DOMPurify sanitization** — All rendered HTML sanitized against XSS

### Sharing

- **Auto-save** — Content saves to server with debounce, URL updates automatically
- **Shareable sessions** — Edit links (with write access) and read-only links
- **Private sessions** — Token-gated viewing. Private sessions require the edit link to access
- **Fork** — Read-only visitors can fork any session into their own editable copy
- **Link previews** — Shared links unfurl with content preview in Slack, Discord, and social media
- **90-day retention** — Sessions expire after 90 days of inactivity (30 days for agent-created)

### Import / Export

- **File import** — Load markdown from local files
- **URL import** — Fetch content from any URL with server-side SSRF protection
- **Download** — Save as Markdown, HTML, or PDF
- **Clipboard** — Copy rendered content as rich text

### Agent / API Access

AI agents and scripts can create, update, and read sessions via pure HTTP — no SDK, no browser, no API key.

```bash
# Create a session (body is raw markdown)
curl -X PUT https://markdown.pentagram.me/api/sessions/$(openssl rand -base64 9 | tr '+/' '_-') \
  -H "Content-Type: text/markdown" \
  --data-binary @draft.md

# Update a session
curl -X PUT https://markdown.pentagram.me/api/sessions/SESSION_ID \
  -H "Content-Type: text/markdown" \
  -H "X-Edit-Token: TOKEN" \
  --data-binary @updated.md

# Read as markdown
curl -H "Accept: text/markdown" https://markdown.pentagram.me/SESSION_ID

# Read as rendered HTML
curl "https://markdown.pentagram.me/SESSION_ID?format=html" > note.html

# Create a private session
curl -X PUT https://markdown.pentagram.me/api/sessions/SESSION_ID \
  -H "Content-Type: text/markdown" \
  -H "X-Private: true" \
  --data-binary "# Private draft"
```

Creation returns `{ id, editToken, url, editUrl }`. Agent-created sessions (no Turnstile token) get 30-day retention; browser-created sessions get 90 days. Rate limiting is the only gate — no API key required.

### MCP Server

AI agents can discover and use all platform capabilities via [Model Context Protocol](https://modelcontextprotocol.io/) — no curl, no copy-paste. The MCP server exposes 13 tools at `/mcp` via Streamable HTTP transport.

**Connect from any MCP client** (Claude Desktop, Cursor, OpenCode, etc.). Point to the demo instance or your own deployment:

```json
{
  "markdown-viewer": {
    "type": "remote",
    "url": "https://markdown.pentagram.me/mcp"
  }
}
```

> Replace the URL with your own instance if you've [deployed your own](#-deploy-to-cloudflare).

**Tools:** `create_document`, `read_document`, `update_document`, `delete_document`, `import_url`, `append_to_document`, `insert_after_line`, `replace_line`, `update_frontmatter`, `batch_read_documents`, `batch_update_documents`, `get_document_history`, `get_backlinks`

**Features agents get:**
- **YAML frontmatter conventions** — `title`, `status`, `sources`, `supersedes` — discovered at connection time via tool descriptions
- **Conditional updates** — ETags prevent clobbering when multiple agents edit
- **Partial read/write** — line-range reads (`offset`/`limit`), frontmatter-only reads, append, insert-after, replace-line
- **Batch operations** — read up to 20 documents or update up to 10 in one call
- **Edit history** — timestamped changelogs via `changeSummary` on writes
- **Backlinks** — platform tracks which documents reference each other
- **Content hash** — SHA-256 for verifying local copies match without downloading

**MCP discovery:** `GET /.well-known/mcp-server-card` returns a [server card](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2127) (experimental, draft SEP-2127).

**Agent skill:** This repo includes a reference skill at [`.opencode/skills/markdown-pad/SKILL.md`](.opencode/skills/markdown-pad/SKILL.md) that teaches AI agents when and how to use the platform effectively — frontmatter conventions, trust model, secrets handling, common workflows. Copy it to your agent's skill directory or use it as a starting point for your own.

### Full API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/sessions/:id` | Read with `offset`/`limit`, `fields=frontmatter`, conditional (`If-None-Match` → 304) |
| PUT | `/api/sessions/:id` | Create or update with `If-Match` (412 on conflict), `changeSummary` |
| PATCH | `/api/sessions/:id` | Partial write: `append`, `insertAfter`, `replaceLine`, `updateFrontmatter` |
| DELETE | `/api/sessions/:id` | Delete session + history + links |
| GET | `/api/sessions/:id/history` | Changelog entries |
| GET | `/api/sessions/:id/backlinks` | Documents that link to this one |
| POST | `/api/sessions/batch/read` | Read multiple (max 20), supports ETags + partial read |
| POST | `/api/sessions/batch/update` | Update multiple (max 10), per-document auth + conditions |
| POST | `/api/import-url` | Fetch markdown from URL (HTTPS only, SSRF-protected) |

### SEO & Content Negotiation

- **Crawler-friendly index** — OG meta tags and feature description injected via HTMLRewriter
- **`Accept: text/markdown`** on `/:id` returns raw markdown content
- **`?format=html`** on `/:id` returns standalone rendered HTML with inline styles
- **`?format=md`** on `/:id` returns raw markdown (alias for Accept header)

Dark mode (system + manual override), mobile responsive layout with bottom sheet menu, and keyboard shortcuts for all primary actions.

## 🚀 Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/keefetang/markdown-viewer)

Zero configuration required. The KV namespace is auto-created, rate limiting is enabled out of the box, and the app works immediately after deploy.

## 🛠️ Local Development

**Prerequisites:** Node.js >= 18, npm

```bash
git clone https://github.com/keefetang/markdown-viewer.git
cd markdown-viewer
npm install
npm run dev
# Opens http://localhost:8787
```

| Command | Description |
|---------|-------------|
| `npm run dev` | Start local dev server |
| `npm run build` | Build for production |
| `npm run deploy` | Deploy to Cloudflare (generic) |
| `npm run deploy:prod` | Deploy with custom domain (requires [setup](#-custom-domain-deploy)) |
| `npm run cf-typegen` | Regenerate Worker type bindings |

> **Note:** `npm run dev` works immediately — Wrangler creates a local KV namespace automatically. For manual production deploy (without the Deploy button), you'll need to create the KV namespace first:
> ```bash
> wrangler kv namespace create SESSIONS
> ```
> Then add the returned `id` to `wrangler.jsonc` under `kv_namespaces`.

## 🌐 Custom Domain Deploy

The default `npm run deploy` uses `wrangler.jsonc` and deploys to a `*.workers.dev` subdomain. To deploy with a custom domain and account-specific settings:

1. Copy the template:
   ```bash
   cp .deploy/wrangler.jsonc.template .deploy/wrangler.jsonc
   ```
2. Edit `.deploy/wrangler.jsonc` — set your `account_id` and custom domain
3. Deploy:
   ```bash
   npm run deploy:prod
   ```

The `.deploy/` directory is gitignored — your account ID and domain stay out of version control. See [`.deploy/wrangler.jsonc.template`](.deploy/wrangler.jsonc.template) for the full reference.

## ⚙️ Configuration

All configuration is optional. The app works fully without any of these — protected by rate limiting only.

| Variable | Purpose | Required |
|----------|---------|----------|
| `CF_ANALYTICS_TOKEN` | Cloudflare Web Analytics (cookie-free) | No |
| `TURNSTILE_SITE_KEY` | Bot protection site key | No |
| `TURNSTILE_SECRET_KEY` | Bot protection secret key | No |
| `CORS_ORIGIN` | Restrict API to specific domain (defaults to `*`) | No |

Set secrets via CLI or the Cloudflare dashboard:

```bash
wrangler secret put TURNSTILE_SECRET_KEY
```

**Recommended for production:** Configure Turnstile for the strongest protection against bot abuse.

## 🏗️ Tech Stack

- **Frontend:** Svelte 5, CodeMirror 6, markdown-it, highlight.js, KaTeX (lazy-loaded), DOMPurify
- **Backend:** Cloudflare Workers + Static Assets + KV
- **Build:** Vite, TypeScript
- **Bundle:** ~79kb gzipped initial load — KaTeX math rendering lazy-loaded only when needed (~293kb)

## 🔒 Security

- **Edit tokens** — Random tokens (~144 bits entropy) protect write access per session. Timing-safe comparison everywhere.
- **Private sessions** — Token-gated viewing prevents unauthorized access (returns 404, not 403 — hides existence)
- **Conditional updates** — `If-Match` / `If-None-Match` ETags prevent accidental overwrites
- **Rate limiting** — All API endpoints rate-limited (30 writes/min, 60 reads/min). MCP and batch count per-document.
- **Turnstile** — Optional bot protection on browser session creation. Agents bypass via rate limiting
- **DOMPurify** — All rendered HTML sanitized against XSS
- **YAML safety** — Frontmatter parsed with YAML 1.2 core schema (no code execution in JS)
- **URL import protection** — Server-side proxy with 11-step SSRF validation chain (protocol, hostname, DNS rebinding, IP range, redirects, content type, size limits)
- **Security headers** — CSP with per-request nonces, Referrer-Policy, and other hardened defaults
- **Input validation** — Content size limits (512 KB) and strict API contracts
- **MCP security** — All MCP write tools enforce same edit token checks as REST API. No privilege escalation.

## 🔐 Privacy

- **No cookies.** No user tracking. No personal data collected or stored.
- **Stored per session:** Markdown content, two timestamps (created/updated), a random edit token (not tied to any user), an optional private flag, and a content hash. No personal data.
- **Analytics:** Optional Cloudflare Web Analytics — cookie-free and GDPR-compliant.
- **Note:** Cloudflare's platform provides standard request logs (including IPs) to the account owner. This app does not log them, but the platform makes them available.

## 📄 License

[MIT](LICENSE)

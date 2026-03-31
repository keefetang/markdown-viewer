# Markdown Viewer

A fast, privacy-first markdown pad with shareable sessions. Write markdown, see a live rendered preview, share via URL — all running on Cloudflare.

## ✨ Features

- **Split-pane editor** — CodeMirror 6 with syntax highlighting, three view modes (Editor / Split / Preview)
- **Live preview** — Real-time rendering with synchronized scrolling
- **GFM support** — Tables, task lists, syntax-highlighted code blocks, LaTeX math (lazy-loaded)
- **Auto-save** — Content persists automatically with debounce
- **Shareable sessions** — Edit links (with write access) and read-only links
- **Fork** — Read-only visitors can fork any session into their own editable copy
- **Import/Export** — Load from local files or URLs (with [11-step security validation](AGENTS.md#url-import-security-11-step-validation-chain)), download as Markdown, HTML, or PDF
- **Copy as rich text** — Copy rendered content to clipboard
- **Content stats** — Live word count, character count, read time
- **OG previews** — Shared links render with Open Graph meta tags for social cards and AI agents
- **Dark mode** — System preference with manual override (System / Light / Dark)
- **Keyboard-driven** — All primary actions accessible via shortcuts
- **90-day retention** — Sessions expire after 90 days of inactivity

## 🚀 Deploy to Cloudflare

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/keefetang/markdown-viewer)

Zero configuration required. The KV namespace is auto-created, rate limiting is enabled out of the box, and the app works immediately after deploy.

## 🛠️ Local Development

**Prerequisites:** Node.js ≥ 18, npm

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

## 🔒 Security

- **Edit tokens** — Random tokens protect write access per session
- **Rate limiting** — All API endpoints are rate-limited (30 writes/min, 60 reads/min)
- **Turnstile** — Optional invisible bot protection on session creation
- **DOMPurify** — All rendered HTML sanitized against XSS
- **Security headers** — CSP, Referrer-Policy, and other hardened defaults
- **Input validation** — Content size limits and strict API contracts

## 🔐 Privacy

- **No cookies.** No user tracking. No personal data collected or stored.
- **Stored per session:** Markdown content, two timestamps (created/updated), and a random edit token (not tied to any user).
- **Analytics:** Optional Cloudflare Web Analytics — cookie-free and GDPR-compliant.
- **Note:** Cloudflare's platform provides standard request logs (including IPs) to the account owner. This app does not log them, but the platform makes them available.

## 📄 License

[MIT](LICENSE)

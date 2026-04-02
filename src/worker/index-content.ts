/**
 * Static content for the index page — HTML for SEO injection and markdown
 * for content negotiation (`Accept: text/markdown`).
 *
 * Kept concise — this is for crawlers and CLI tools, not a landing page.
 */

// ---- HTML Content ----

export function getIndexHtml(): string {
  return `<h1>Markdown Viewer</h1>
<p>A fast, privacy-first markdown pad. Write markdown, see a live rendered preview, and share via a unique URL. No accounts required.</p>
<h2>Features</h2>
<ul>
<li>Split-pane editor with live preview, synchronized scrolling, and three view modes</li>
<li>GFM support — tables, task lists, strikethrough, syntax-highlighted code blocks, and KaTeX math</li>
<li>Auto-save with shareable URLs — edit links with write access and read-only links for sharing</li>
<li>Import from files or URLs, export as Markdown, HTML, or PDF</li>
<li>Deploy your own instance to Cloudflare in one click — zero configuration required</li>
</ul>
<p>No cookies. No tracking. No user accounts. Sessions contain only your markdown and timestamps, and auto-expire after 90 days of inactivity.</p>
<p><a href="https://github.com/keefetang/markdown-viewer">View on GitHub</a></p>`;
}

// ---- Markdown Content ----

export function getIndexMarkdown(): string {
  return `# Markdown Viewer

A fast, privacy-first markdown pad. Write markdown, see a live rendered preview, and share via a unique URL. No accounts required.

## Features

- Split-pane editor with live preview, synchronized scrolling, and three view modes
- GFM support — tables, task lists, strikethrough, syntax-highlighted code blocks, and KaTeX math
- Auto-save with shareable URLs — edit links with write access and read-only links for sharing
- Import from files or URLs, export as Markdown, HTML, or PDF
- Deploy your own instance to Cloudflare in one click — zero configuration required

No cookies. No tracking. No user accounts. Sessions contain only your markdown and timestamps, and auto-expire after 90 days of inactivity.

[View on GitHub](https://github.com/keefetang/markdown-viewer)
`;
}

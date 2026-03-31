/**
 * Export utilities — download, print, and clipboard operations.
 *
 * All exports work from raw markdown content. No server involvement.
 * - Markdown: Blob download as `.md`
 * - HTML: standalone doc with inline preview CSS
 * - PDF: `window.print()` — @media print CSS in global.css hides chrome
 * - Copy rendered: Clipboard API with `text/html` MIME type
 */

import { renderMarkdown, extractTitle } from '../../shared/markdown';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Download raw markdown as a `.md` file. */
export function downloadMarkdown(content: string, sessionId: string | null): void {
  const filename = sessionId ? `${sessionId}.md` : 'untitled.md';
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  downloadBlob(blob, filename);
}

/** Download rendered HTML as a standalone `.html` file. */
export function downloadHtml(content: string, title: string): void {
  const html = renderMarkdown(content);
  const doc = buildHtmlDocument(html, title);
  const blob = new Blob([doc], { type: 'text/html;charset=utf-8' });
  downloadBlob(blob, `${sanitizeFilename(title) || 'untitled'}.html`);
}

/** Print to PDF via browser print dialog. */
export function printToPdf(): void {
  window.print();
}

/**
 * Copy rendered markdown as rich text to clipboard.
 * Returns `true` on success, `false` on failure.
 */
export async function copyRendered(content: string): Promise<boolean> {
  const html = renderMarkdown(content);
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([content], { type: 'text/plain' }),
      }),
    ]);
    return true;
  } catch {
    // Fallback: copy plain text
    try {
      await navigator.clipboard.writeText(content);
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Trigger a browser download for a Blob. */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  // Clean up after browser has initiated the download
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 1000);
}

/** Sanitize a string for use as a filename. */
function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 100);
}

/**
 * Build a complete standalone HTML document with inline styles.
 * Includes essential markdown rendering styles so the file looks
 * good when opened directly in a browser.
 */
function buildHtmlDocument(renderedHtml: string, title: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${INLINE_STYLES}
</style>
</head>
<body>
<article class="markdown-body">
${renderedHtml}
</article>
</body>
</html>`;
}

/** Escape HTML special characters for safe embedding in attributes/text. */
const HTML_ESCAPE_MAP: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch] || ch);
}

/**
 * Essential inline styles for standalone HTML export.
 * A minimal subset of preview styles — enough for the markdown to
 * look good when opened directly in a browser. NOT the entire
 * preview.css — just the core typographic and structural rules.
 */
const INLINE_STYLES = `
/* Reset */
*, *::before, *::after { box-sizing: border-box; }
* { margin: 0; padding: 0; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui,
    'Helvetica Neue', Helvetica, Arial, sans-serif;
  font-size: 15px;
  line-height: 1.6;
  color: #2c2824;
  background: #faf8f5;
  padding: 2rem;
}

.markdown-body {
  max-width: 72ch;
  margin: 0 auto;
}

/* Headings */
.markdown-body h1, .markdown-body h2, .markdown-body h3,
.markdown-body h4, .markdown-body h5, .markdown-body h6 {
  margin-top: 1.5em;
  margin-bottom: 0.5em;
  font-weight: 600;
  line-height: 1.25;
  letter-spacing: -0.01em;
}
.markdown-body h1 { font-size: 1.5rem; border-bottom: 1px solid rgba(44,40,36,0.12); padding-bottom: 0.3em; }
.markdown-body h2 { font-size: 1.25rem; border-bottom: 1px solid rgba(44,40,36,0.12); padding-bottom: 0.3em; }
.markdown-body h3 { font-size: 1.0625rem; }

/* Paragraphs & lists */
.markdown-body p, .markdown-body ul, .markdown-body ol, .markdown-body dl {
  margin-top: 0;
  margin-bottom: 1em;
}
.markdown-body ul, .markdown-body ol { padding-left: 2em; }
.markdown-body li + li { margin-top: 0.25em; }

/* Links */
.markdown-body a {
  color: #3d6d8e;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.markdown-body a:hover { color: #325c78; }

/* Code */
.markdown-body code, .markdown-body tt {
  background-color: #efebe5;
  color: #5c4a3a;
  font-family: ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace;
  font-size: 0.9em;
  border-radius: 3px;
  padding: 0.15em 0.35em;
}
.markdown-body pre {
  background-color: #efebe5;
  border: 1px solid rgba(44,40,36,0.06);
  border-radius: 5px;
  padding: 0.75rem;
  overflow-x: auto;
  margin-bottom: 1em;
}
.markdown-body pre code {
  background: transparent;
  padding: 0;
  font-size: 0.8125rem;
  line-height: 1.6;
}

/* Blockquotes */
.markdown-body blockquote {
  border-left: 3px solid rgba(44,40,36,0.20);
  color: #5c5650;
  padding-left: 1rem;
  margin-bottom: 1em;
}

/* Tables */
.markdown-body table {
  border-collapse: collapse;
  width: 100%;
  margin-bottom: 1em;
}
.markdown-body table th, .markdown-body table td {
  border: 1px solid rgba(44,40,36,0.12);
  padding: 0.5rem 0.75rem;
  text-align: left;
}
.markdown-body table th {
  background-color: #f3f0eb;
  font-weight: 600;
}
.markdown-body table tr:nth-child(2n) {
  background-color: #f3f0eb;
}

/* Horizontal rule */
.markdown-body hr {
  height: 1px;
  background-color: rgba(44,40,36,0.12);
  border: none;
  margin: 1.5em 0;
}

/* Images */
.markdown-body img {
  max-width: 100%;
  border-radius: 5px;
}

/* Task lists */
.markdown-body .task-list-item {
  list-style-type: none;
}
.markdown-body .task-list-item input[type="checkbox"] {
  margin-right: 0.5em;
}

/* Strong & emphasis */
.markdown-body strong { font-weight: 600; }
.markdown-body em { font-style: italic; }
.markdown-body del { text-decoration: line-through; color: #8a8480; }

/* Dark mode */
@media (prefers-color-scheme: dark) {
  body {
    color: #e8e4df;
    background: #1c1a18;
  }
  .markdown-body a { color: #6ba3c7; }
  .markdown-body a:hover { color: #82b5d6; }
  .markdown-body code, .markdown-body tt {
    background-color: #232018;
    color: #c8b8a8;
  }
  .markdown-body pre {
    background-color: #232018;
    border-color: rgba(232,228,223,0.06);
  }
  .markdown-body blockquote {
    border-left-color: rgba(232,228,223,0.20);
    color: #b5b0a9;
  }
  .markdown-body table th, .markdown-body table td {
    border-color: rgba(232,228,223,0.12);
  }
  .markdown-body table th { background-color: #141210; }
  .markdown-body table tr:nth-child(2n) { background-color: #141210; }
  .markdown-body hr { background-color: rgba(232,228,223,0.12); }
  .markdown-body h1, .markdown-body h2 { border-bottom-color: rgba(232,228,223,0.12); }
  .markdown-body del { color: #7d7872; }
}
`.trim();

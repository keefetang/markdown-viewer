/**
 * Standalone HTML document builder for rendered markdown.
 *
 * Shared between client (export.ts) and Worker (content negotiation).
 * No browser-only APIs — pure string construction, safe for Workers.
 */

import { escapeForHtml } from './escape';

/**
 * Build a complete standalone HTML document with inline styles.
 * The file looks good when opened directly in a browser — light and dark
 * mode, typography, code blocks, tables, all self-contained.
 */
export function buildHtmlDocument(renderedHtml: string, title: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeForHtml(title)}</title>
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
  white-space: pre-wrap;
  word-break: break-all;
}
@media print {
  .markdown-body pre { overflow-x: visible; }
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

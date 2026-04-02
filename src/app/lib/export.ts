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
import { buildHtmlDocument } from '../../shared/html-document';

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

/**
 * Print rendered markdown to PDF via browser print dialog.
 * Renders the full content into a hidden same-origin iframe so the browser's
 * print header/footer shows the real page URL. Bypasses the SPA's split-pane
 * layout which would print only the visible portion.
 */
export function printToPdf(content: string, title: string): void {
  const html = renderMarkdown(content);
  const doc = buildHtmlDocument(html, title);

  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = 'none';
  iframe.style.opacity = '0';
  document.body.appendChild(iframe);

  const iframeDoc = iframe.contentDocument;
  if (!iframeDoc) {
    document.body.removeChild(iframe);
    return;
  }

  iframeDoc.open();
  iframeDoc.write(doc);
  iframeDoc.close();

  iframe.contentWindow?.addEventListener('afterprint', () => {
    document.body.removeChild(iframe);
  });

  setTimeout(() => {
    iframe.contentWindow?.print();
  }, 100);
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

// buildHtmlDocument and INLINE_STYLES live in src/shared/html-document.ts
// (shared between client export and Worker content negotiation).



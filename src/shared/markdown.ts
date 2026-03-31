/**
 * Shared markdown rendering pipeline.
 *
 * Works identically in both the browser (Svelte SPA) and the Cloudflare Worker.
 * - GFM: tables, strikethrough, task lists, fenced code blocks (built-in + plugin)
 * - Syntax highlighting: 10 core languages via highlight.js/lib/core
 * - KaTeX math: lazy-loaded on demand — NOT in the initial import
 * - XSS defense: `html: false` (non-negotiable)
 * - External links: `rel="noopener noreferrer"` + `target="_blank"`
 *
 * No browser-only APIs — pure JS/TS, safe for Workers.
 */

import MarkdownIt from 'markdown-it';
import type { Options as MarkdownItOptions } from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import hljs from 'highlight.js/lib/core';

// Tree-shaken highlight.js: only 10 core languages
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';

// Register languages once at module load
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('json', json);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('html', xml); // html is an alias for xml in hljs
hljs.registerLanguage('css', css);
hljs.registerLanguage('go', go);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('sql', sql);

/** Shared markdown-it configuration. html: false is non-negotiable (XSS defense). */
const baseConfig: MarkdownItOptions = {
  html: false,
  linkify: true,
  typographer: false,
  highlight(str: string, lang: string): string {
    // When a language is specified but not registered, render as plain text
    // rather than guessing with highlightAuto (which would misclassify against
    // our limited 10-language set). Auto-detect only when no language is given.
    if (lang && !hljs.getLanguage(lang)) return '';

    try {
      const result = lang
        ? hljs.highlight(str, { language: lang })
        : hljs.highlightAuto(str);
      // Safety: result.value is pre-escaped by highlight.js — this is the one
      // sanctioned path where raw HTML bypasses markdown-it's html:false setting.
      return `<pre class="hljs"><code>${result.value}</code></pre>`;
    } catch {
      // Fallback: return empty so markdown-it renders as plain escaped text
      return '';
    }
  },
};

/**
 * Create a markdown-it instance with our standard plugins and link rules.
 * Factored out so both `md` and `mdWithKatex` share identical base config.
 */
function createBaseInstance(): MarkdownIt {
  const instance = new MarkdownIt(baseConfig);

  // Task lists (checkboxes in lists)
  instance.use(taskLists, { enabled: false, label: true, labelAfter: true });

  // External link handling: target="_blank" + rel="noopener noreferrer"
  applyExternalLinkRules(instance);

  return instance;
}

/**
 * Override link_open renderer to add security attributes to external links.
 * External = any href starting with http:// or https://
 */
function applyExternalLinkRules(instance: MarkdownIt): void {
  const defaultRender =
    instance.renderer.rules.link_open ??
    function (tokens, idx, options, _env, self) {
      return self.renderToken(tokens, idx, options);
    };

  instance.renderer.rules.link_open = function (tokens, idx, options, env, self) {
    const token = tokens[idx];
    const href = token.attrGet('href');

    if (href && /^https?:\/\//i.test(href)) {
      token.attrSet('target', '_blank');
      token.attrSet('rel', 'noopener noreferrer');
    }

    return defaultRender(tokens, idx, options, env, self);
  };
}

// ─── Base instance (always available, no KaTeX) ────────────────────────────

const md = createBaseInstance();

// ─── KaTeX lazy-loading state ──────────────────────────────────────────────
// Two separate markdown-it instances: `md` (always available, ~25kb) and
// `mdWithKatex` (created on demand after async import of KaTeX ~800kb).
// A single instance can't add plugins after initialization, so the lazy
// instance is a full clone with the KaTeX plugin pre-registered. This keeps
// the initial page load under 175kb gzipped.

let mdWithKatex: MarkdownIt | null = null;
let katexLoadPromise: Promise<void> | null = null;

/** Pattern to detect math syntax: inline $...$ or display $$...$$ */
const MATH_PATTERN = /\$\$[\s\S]+?\$\$|\$[^\s$]([^$]*[^\s$])?\$/;

// ─── Text extraction (isomorphic — works in both browser and Worker) ───────

/** Strip common inline markdown formatting from a string. */
export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')   // bold
    .replace(/\*(.+?)\*/g, '$1')       // italic
    .replace(/`(.+?)`/g, '$1')         // inline code
    .replace(/\[(.+?)\]\(.+?\)/g, '$1') // links
    .replace(/!\[.*?\]\(.*?\)/g, '')    // images
    .trim();
}

/**
 * Extract a title from markdown content.
 * Tries the first `# heading`, then falls back to the first non-empty line.
 * Strips inline formatting (bold, italic, code, links) from the result.
 */
export function extractTitle(markdown: string): string {
  const headingMatch = markdown.match(/^#\s+(.+)$/m);
  if (headingMatch) {
    const stripped = stripInlineMarkdown(headingMatch[1]);
    if (stripped) return stripped.substring(0, 100);
  }

  const firstLine = markdown.split('\n').find((line) => line.trim());
  if (firstLine) {
    const stripped = stripInlineMarkdown(firstLine);
    if (stripped) return stripped.substring(0, 100);
  }

  return 'Untitled';
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Render markdown to HTML using the base instance (no KaTeX).
 * Synchronous, always available, fast.
 */
export function renderMarkdown(source: string): string {
  return md.render(source);
}

/**
 * Check if content contains math syntax (`$...$` or `$$...$$`).
 * Use this to decide whether to load KaTeX.
 */
export function containsMath(source: string): boolean {
  return MATH_PATTERN.test(source);
}

/**
 * Check if KaTeX has been loaded and the enhanced renderer is ready.
 */
export function isKatexLoaded(): boolean {
  return mdWithKatex !== null;
}

/**
 * Lazily load KaTeX and create the enhanced markdown-it instance.
 * Safe to call multiple times — subsequent calls return immediately if already loaded,
 * or await the in-flight load if one is in progress.
 *
 * @remarks
 * KaTeX CSS must be loaded separately by the caller (e.g., inject a stylesheet
 * link when this resolves). The render function does not handle CSS.
 */
export function loadKatex(): Promise<void> {
  if (mdWithKatex) return Promise.resolve();

  // Deduplicate concurrent calls: all callers share the same in-flight promise
  if (!katexLoadPromise) {
    katexLoadPromise = doLoadKatex();
  }

  return katexLoadPromise;
}

/**
 * Render markdown to HTML with KaTeX math support.
 * Only works after `loadKatex()` has resolved — otherwise falls back to
 * the base renderer (math expressions render as raw text).
 */
export function renderMarkdownWithKatex(source: string): string {
  if (mdWithKatex) {
    return mdWithKatex.render(source);
  }
  // Fallback: base renderer, math shows as raw text
  return md.render(source);
}

// ─── Internal helpers ──────────────────────────────────────────────────────

async function doLoadKatex(): Promise<void> {
  try {
    // Dynamic import — @vscode/markdown-it-katex bundles katex internally.
    // This entire chunk is tree-shaken out of the initial bundle.
    const katexPlugin = await import('@vscode/markdown-it-katex');

    const instance = createBaseInstance();
    // The plugin is a CJS default export; handle both ESM and CJS interop shapes
    const pluginFn = katexPlugin.default ?? katexPlugin;
    instance.use(pluginFn, { throwOnError: false });

    mdWithKatex = instance;
  } catch (err) {
    // Reset so a future call can retry on failure
    katexLoadPromise = null;
    throw err;
  }
}

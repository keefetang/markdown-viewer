/**
 * Shared markdown rendering pipeline.
 *
 * Works identically in both the browser (Svelte SPA) and the Cloudflare Worker.
 * - GFM: tables, strikethrough, task lists, fenced code blocks (built-in + plugin)
 * - Syntax highlighting: 11 core languages via highlight.js/lib/core (incl. yaml)
 * - Frontmatter: YAML frontmatter rendered as a syntax-highlighted `<pre>` block
 * - Heading anchors: `id` + clickable `#` link for deep linking
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

// Tree-shaken highlight.js: 11 core languages
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
import yaml from 'highlight.js/lib/languages/yaml';

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
hljs.registerLanguage('yaml', yaml);

// ─── Frontmatter detection ─────────────────────────────────────────────────
// Matches a YAML frontmatter block at the start of content: ---\n...\n---
// The (?:\r?\n)? before closing --- is optional to handle empty blocks (---\n---).
// Aligned with the parse regex in frontmatter.ts.
const FRONTMATTER_RENDER_RE = /^---\r?\n([\s\S]*?)(?:\r?\n)?---(?:\r?\n|$)/;

// ─── Heading slug helpers ──────────────────────────────────────────────────

/** Slugify heading text: lowercase, spaces → hyphens, strip non-alphanumeric except `-`. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

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

  // Heading anchors: add id + clickable # link for deep linking
  applyHeadingAnchors(instance);

  // Source line mapping: data-line attributes for scroll sync
  applySourceLineMapping(instance);

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

/**
 * Override heading_open renderer to add `id` attributes and anchor links
 * for deep linking. Handles duplicate headings by appending `-1`, `-2` suffixes.
 *
 * Each render call gets its own slug counter via the `env` object that
 * markdown-it passes through the render pipeline.
 */
function applyHeadingAnchors(instance: MarkdownIt): void {
  const defaultRender =
    instance.renderer.rules.heading_open ??
    function (tokens, idx, options, _env, self) {
      return self.renderToken(tokens, idx, options);
    };

  instance.renderer.rules.heading_open = function (tokens, idx, options, env, self) {
    // Initialize slug tracker on the env object (fresh per render call)
    if (!env._slugCounts) {
      env._slugCounts = {} as Record<string, number>;
    }
    const slugCounts = env._slugCounts as Record<string, number>;

    // Extract plain text from inline children (the token after heading_open is inline)
    const inlineToken = tokens[idx + 1];
    const rawText = inlineToken?.children
      ?.filter((t) => t.type === 'text' || t.type === 'code_inline')
      .map((t) => t.content)
      .join('') ?? '';

    const baseSlug = slugify(rawText) || 'heading';

    // Handle duplicate slugs: first occurrence is bare, subsequent get -1, -2, etc.
    const count = slugCounts[baseSlug] ?? 0;
    slugCounts[baseSlug] = count + 1;
    const slug = count === 0 ? baseSlug : `${baseSlug}-${count}`;

    // Add id attribute to the heading token
    const token = tokens[idx];
    token.attrSet('id', slug);

    // Store slug on env so heading_close can append the anchor AFTER the heading text
    env._currentSlug = slug;

    return defaultRender(tokens, idx, options, env, self);
  };

  // heading_close: append the anchor link AFTER the heading text, before </hN>
  const defaultCloseRender =
    instance.renderer.rules.heading_close ??
    function (tokens, idx, options, _env, self) {
      return self.renderToken(tokens, idx, options);
    };

  instance.renderer.rules.heading_close = function (tokens, idx, options, env, self) {
    const slug = env._currentSlug as string | undefined;
    env._currentSlug = undefined;

    if (slug) {
      return ` <a class="heading-anchor" href="#${slug}" aria-hidden="true">&#128279;</a>${defaultCloseRender(tokens, idx, options, env, self)}`;
    }
    return defaultCloseRender(tokens, idx, options, env, self);
  };
}

/**
 * Override renderToken to inject `data-line` attributes on block-level opening
 * tokens that carry source-map info (`token.map`). This enables content-based
 * scroll sync between the editor and preview: each rendered block knows which
 * source line produced it.
 *
 * The line value stored is 0-indexed (`token.map[0]`), matching CodeMirror's
 * 0-indexed line model. When frontmatter is present, `renderWithFrontmatter`
 * sets `renderer._lineOffset` so the data-line values correspond to absolute
 * source lines (including the frontmatter block the editor still displays).
 */
function applySourceLineMapping(instance: MarkdownIt): void {
  const defaultRenderToken = instance.renderer.renderToken.bind(instance.renderer);

  instance.renderer.renderToken = function (tokens, idx, options) {
    const token = tokens[idx];
    // Only add to opening block-level tokens that have source map info.
    // Safety: _lineOffset is set/cleared synchronously around instance.render()
    // in renderWithFrontmatter(). This is safe because render() is synchronous.
    if (token.map && token.map.length >= 2 && token.nesting === 1) {
      const lineOffset = (this as RendererWithOffset)._lineOffset ?? 0;
      token.attrSet('data-line', String(token.map[0] + lineOffset));
    }
    return defaultRenderToken(tokens, idx, options);
  };
}

/** Extended renderer type for line offset tracking. */
interface RendererWithOffset {
  _lineOffset?: number;
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
 *
 * If the source starts with a YAML frontmatter block, it is stripped from
 * the markdown body and rendered as a syntax-highlighted `<pre>` block
 * prepended to the output.
 */
export function renderMarkdown(source: string): string {
  return renderWithFrontmatter(source, md);
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
 *
 * If the source starts with a YAML frontmatter block, it is stripped from
 * the markdown body and rendered as a syntax-highlighted `<pre>` block
 * prepended to the output.
 */
export function renderMarkdownWithKatex(source: string): string {
  const instance = mdWithKatex ?? md;
  return renderWithFrontmatter(source, instance);
}

// ─── Internal helpers ──────────────────────────────────────────────────────

/**
 * Render markdown source with optional frontmatter extraction.
 *
 * If the source starts with a YAML frontmatter block (`---\n...\n---`):
 * 1. Strips it from the markdown body
 * 2. Highlights the YAML using hljs (including `---` delimiters for clarity)
 * 3. Prepends the highlighted `<pre class="hljs frontmatter">` block to the output
 *
 * This runs on every render — both client-side (Preview.svelte) and server-side
 * (SSR, ?format=html) since markdown.ts is shared.
 */
function renderWithFrontmatter(source: string, instance: MarkdownIt): string {
  const match = source.match(FRONTMATTER_RENDER_RE);
  const renderer = instance.renderer as MarkdownIt['renderer'] & RendererWithOffset;

  if (!match) {
    // No frontmatter — line numbers are 1:1 with the editor
    renderer._lineOffset = 0;
    const html = instance.render(source);
    renderer._lineOffset = 0;
    return html;
  }

  // Display just the YAML content without --- delimiters.
  // For empty frontmatter (---\n---), match[1] is '' — skip the block entirely.
  const inner = match[1];

  // Count the lines consumed by the frontmatter block (including --- delimiters
  // and trailing newline) so markdown-it's 0-indexed line numbers can be offset
  // to match the editor's absolute line numbers.
  const frontmatterLineCount = match[0].split('\n').length - (match[0].endsWith('\n') ? 1 : 0);

  if (!inner.trim()) {
    renderer._lineOffset = frontmatterLineCount;
    const html = instance.render(source.slice(match[0].length));
    renderer._lineOffset = 0;
    return html;
  }
  const yamlContent = inner;

  // Highlight the YAML block
  let highlightedYaml: string;
  try {
    const result = hljs.highlight(yamlContent, { language: 'yaml' });
    highlightedYaml = result.value;
  } catch {
    // Fallback: escape manually if highlighting fails
    highlightedYaml = yamlContent
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // data-line="0" on the frontmatter block — it starts at line 0 in the editor
  const frontmatterHtml = `<pre class="hljs frontmatter" data-line="0"><code>${highlightedYaml}</code></pre>\n`;

  // Strip the frontmatter block from the source before rendering the body.
  // The regex match includes up to the closing --- and optional trailing newline.
  // Set the line offset so renderToken adds frontmatterLineCount to each data-line.
  const body = source.slice(match[0].length);
  renderer._lineOffset = frontmatterLineCount;
  const bodyHtml = instance.render(body);
  renderer._lineOffset = 0;

  return frontmatterHtml + bodyHtml;
}

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

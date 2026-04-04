<script lang="ts">
  /**
   * Markdown preview pane.
   *
   * Renders markdown source to sanitized HTML using the shared pipeline.
   * Handles KaTeX lazy-loading when math syntax is detected.
   */
  import DOMPurify from 'dompurify';
  import { renderMarkdown, containsMath, isKatexLoaded, loadKatex, renderMarkdownWithKatex } from '../../shared/markdown';
  import '../styles/preview.css';

  // ─── Props (Svelte 5 runes) ──────────────────────────────────────────────

  interface Props {
    content?: string;
    onscroll?: (line: number) => void;
    onanchornavigate?: (slug: string, targetScrollTop: number) => void;
  }

  let {
    content = '',
    onscroll,
    onanchornavigate,
  }: Props = $props();

  // ─── Internal state ──────────────────────────────────────────────────────

  let containerEl: HTMLDivElement;

  /**
   * Tracks whether KaTeX has finished loading and we should re-render.
   * Bumped after loadKatex() resolves to trigger $derived recalculation.
   */
  let katexReady = $state(false);

  // ─── DOMPurify configuration ──────────────────────────────────────────────

  /**
   * Allow KaTeX's MathML elements and heading anchors through DOMPurify.
   * - KaTeX generates <semantics> and <annotation> for accessible math
   * - Heading anchors need `id` on headings and `class`/`aria-hidden` on <a> tags
   *
   * DOMPurify allows `href` and `class` on <a> tags by default, but `id` on
   * arbitrary elements and `aria-hidden` need explicit allowlisting.
   */
  const SANITIZE_CONFIG = {
    ADD_TAGS: ['semantics', 'annotation'] as string[],
    ADD_ATTR: ['id', 'aria-hidden', 'data-line'] as string[],
  };

  // ─── Derived HTML ─────────────────────────────────────────────────────────

  /**
   * Render pipeline: markdown source → HTML → DOMPurify.sanitize()
   *
   * The `katexReady` dependency ensures we re-render after KaTeX loads,
   * switching from the base renderer (math as raw text) to the KaTeX renderer.
   */
  let sanitizedHtml = $derived.by(() => {
    const rawHtml = (katexReady && isKatexLoaded())
      ? renderMarkdownWithKatex(content)
      : renderMarkdown(content);

    // Defense-in-depth: sanitize all HTML before rendering.
    // markdown-it's html:false is the first layer; this is the second.
    return DOMPurify.sanitize(rawHtml, SANITIZE_CONFIG);
  });

  // ─── KaTeX lazy loading ───────────────────────────────────────────────────

  $effect(() => {
    if (containsMath(content) && !isKatexLoaded()) {
      void loadKatex().then(() => {
        injectKatexCss();
        katexReady = true;
      }).catch(() => {
        // loadKatex() resets its internal state on failure, allowing retry
        // on the next content change that contains math syntax.
        console.warn('KaTeX failed to load — math will render as plain text');
      });
    }
  });

  /**
   * Inject KaTeX CSS as a <link> element (once, globally).
   * Checks for an existing KaTeX link to avoid duplicates if the
   * Preview component is destroyed and re-created.
   */
  function injectKatexCss(): void {
    if (document.querySelector('link[href*="katex"]')) return;

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://cdn.jsdelivr.net/npm/katex@0.16/dist/katex.min.css';
    link.crossOrigin = 'anonymous';
    document.head.appendChild(link);
  }

  // ─── Copy-to-clipboard buttons on code blocks ─────────────────────────────

  /** Duration to show "Copied!" feedback before reverting to "Copy". */
  const COPY_FEEDBACK_MS = 1500;

  /**
   * After each render: inject copy buttons on code blocks.
   */
  $effect(() => {
    // Subscribe to sanitizedHtml so this re-runs on every render
    void sanitizedHtml;

    if (!containerEl) return;

    const preElements = containerEl.querySelectorAll<HTMLPreElement>('pre');

    for (const pre of preElements) {
      // Skip if already has a copy button (shouldn't happen, but defensive)
      if (pre.querySelector('.copy-code-btn')) continue;

      const btn = document.createElement('button');
      btn.className = 'copy-code-btn';
      btn.textContent = 'Copy';
      btn.type = 'button';
      btn.setAttribute('aria-label', 'Copy code to clipboard');

      btn.addEventListener('click', () => {
        // Read text from the <code> child, or fall back to the <pre> itself
        const code = pre.querySelector('code');
        const text = code?.textContent ?? pre.textContent ?? '';

        void navigator.clipboard.writeText(text).then(() => {
          btn.textContent = 'Copied!';
          btn.classList.add('copied');
          setTimeout(() => {
            btn.textContent = 'Copy';
            btn.classList.remove('copied');
          }, COPY_FEEDBACK_MS);
        }).catch(() => {
          // Clipboard API may be unavailable — degrade gracefully
        });
      });

      pre.appendChild(btn);
    }
  });

  // ─── Heading anchor click handling ────────────────────────────────────────
  // Delegated event listener: intercepts clicks on .heading-anchor links
  // and scrolls smoothly within the preview pane. Replaces the inline
  // onclick handler that DOMPurify strips.

  function handlePreviewClick(e: MouseEvent): void {
    const anchor = (e.target as HTMLElement).closest?.('a.heading-anchor');
    if (!anchor) return;

    e.preventDefault();
    const href = anchor.getAttribute('href');
    if (!href?.startsWith('#')) return;

    const slug = href.slice(1);
    const target = containerEl?.querySelector(`#${CSS.escape(slug)}`);
    if (!target || !containerEl) return;

    const targetScrollTop = (target as HTMLElement).getBoundingClientRect().top
      - containerEl.getBoundingClientRect().top
      + containerEl.scrollTop;

    if (onanchornavigate) {
      // Coordinated scroll — parent owns both scroll and URL update
      onanchornavigate(slug, targetScrollTop);
    } else {
      // Preview-only mode — fall back to native smooth scroll + URL update
      target.scrollIntoView({ behavior: 'smooth' });
      history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${slug}`);
    }
  }

  // ─── Scroll handling ──────────────────────────────────────────────────────

  /**
   * Find the source line at the top of the preview viewport by reading
   * `data-line` markers injected by the markdown-it source line mapping.
   * Returns a fractional 0-indexed line number with sub-line precision
   * via interpolation between adjacent markers.
   */
  function getTopSourceLine(): number {
    if (!containerEl) return 0;

    const containerTop = containerEl.getBoundingClientRect().top;

    const markers = [...containerEl.querySelectorAll<HTMLElement>('[data-line]')]
      .map(el => ({
        line: parseInt(el.dataset.line ?? '0', 10),
        top: el.getBoundingClientRect().top,
      }))
      .sort((a, b) => a.line - b.line);

    if (markers.length === 0) return 0;

    // Find the last marker that's at or above the viewport top
    let prevIdx = 0;
    for (let i = 0; i < markers.length; i++) {
      if (markers[i].top > containerTop) break;
      prevIdx = i;
    }

    const prev = markers[prevIdx];
    const next = markers[prevIdx + 1];

    if (!next || next.top <= prev.top) return prev.line;

    // Interpolate: how far between prev and next are we?
    const fraction = (containerTop - prev.top) / (next.top - prev.top);
    return prev.line + fraction * (next.line - prev.line);
  }

  function handleScroll(): void {
    if (!onscroll || !containerEl) return;
    onscroll(getTopSourceLine());
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /** Scroll the preview to a source line (0-indexed, fractional). */
  export function scrollToSourceLine(line: number): void {
    if (!containerEl) return;

    // Convert viewport-relative positions to scroll-relative positions.
    // getBoundingClientRect() is viewport-relative; adding containerEl.scrollTop
    // and subtracting the container's own top gives scroll-absolute offsets.
    const containerRect = containerEl.getBoundingClientRect();
    const markers = [...containerEl.querySelectorAll<HTMLElement>('[data-line]')]
      .map(el => ({
        line: parseInt(el.dataset.line ?? '0', 10),
        top: el.getBoundingClientRect().top - containerRect.top + containerEl.scrollTop,
      }))
      .sort((a, b) => a.line - b.line);

    if (markers.length === 0) return;

    // Find the markers bracketing the target line
    let prev = markers[0];
    let next = markers[markers.length - 1];

    for (let i = 0; i < markers.length; i++) {
      if (markers[i].line <= line) prev = markers[i];
      if (markers[i].line >= line && markers[i] !== prev) {
        next = markers[i];
        break;
      }
    }

    if (prev.line === next.line || prev === next) {
      containerEl.scrollTop = prev.top;
      return;
    }

    // Interpolate position
    const fraction = (line - prev.line) / (next.line - prev.line);
    containerEl.scrollTop = prev.top + fraction * (next.top - prev.top);
  }

  /** Get the scroll container element for external animation control. */
  export function getScrollContainer(): HTMLElement | null {
    return containerEl ?? null;
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="preview-container"
  bind:this={containerEl}
  onscroll={handleScroll}
  onclick={handlePreviewClick}
  data-pane="preview"
>
  <div class="markdown-body preview-content">
    {@html sanitizedHtml}
  </div>
</div>

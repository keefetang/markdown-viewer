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
    onscroll?: (ratio: number) => void;
  }

  let {
    content = '',
    onscroll,
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
   * Allow KaTeX's MathML elements through DOMPurify.
   * KaTeX generates <semantics> and <annotation> for accessible math —
   * DOMPurify strips these by default.
   */
  const SANITIZE_CONFIG = {
    ADD_TAGS: ['semantics', 'annotation'] as string[],
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

  // ─── Scroll handling ──────────────────────────────────────────────────────

  function handleScroll(): void {
    if (!onscroll || !containerEl) return;
    const { scrollTop, scrollHeight, clientHeight } = containerEl;
    const maxScroll = scrollHeight - clientHeight;
    if (maxScroll <= 0) {
      onscroll(0);
      return;
    }
    onscroll(scrollTop / maxScroll);
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /** Set the scroll position by ratio (0-1). Called by parent for sync scrolling. */
  export function setScrollRatio(ratio: number): void {
    if (!containerEl) return;
    const { scrollHeight, clientHeight } = containerEl;
    const maxScroll = scrollHeight - clientHeight;
    if (maxScroll <= 0) return;
    containerEl.scrollTop = ratio * maxScroll;
  }
</script>

<div
  class="preview-container"
  bind:this={containerEl}
  onscroll={handleScroll}
  data-pane="preview"
>
  <div class="markdown-body preview-content">
    {@html sanitizedHtml}
  </div>
</div>

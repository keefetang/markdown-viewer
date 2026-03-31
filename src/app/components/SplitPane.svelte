<script lang="ts">
  /**
   * Resizable split pane — the transformation boundary.
   *
   * Horizontal flexbox layout with a draggable divider.
   * The parent provides two child elements via the `left` and `right` snippets.
   * This component handles resize mechanics only — it does NOT handle
   * view modes. The parent (App.svelte) controls visibility.
   */
  import { onMount } from 'svelte';
  import type { Snippet } from 'svelte';

  // ─── Props ────────────────────────────────────────────────────────────────

  interface Props {
    left: Snippet;
    right: Snippet;
  }

  let { left, right }: Props = $props();

  // ─── State ────────────────────────────────────────────────────────────────

  const STORAGE_KEY = 'markdown-viewer-split-ratio';
  const MIN_PANE_WIDTH = 200; // px — prevent either pane from collapsing
  const DEFAULT_RATIO = 0.5;

  let ratio = $state(DEFAULT_RATIO);
  let isDragging = $state(false);
  let containerEl: HTMLDivElement;

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  onMount(() => {
    // Restore saved ratio
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = parseFloat(saved);
        if (!isNaN(parsed) && parsed > 0 && parsed < 1) {
          ratio = parsed;
        }
      }
    } catch {
      // localStorage unavailable (private browsing) — use default ratio
    }
  });

  // Persist ratio changes (debounced by nature — only fires on drag end)
  function persistRatio(): void {
    try {
      localStorage.setItem(STORAGE_KEY, ratio.toString());
    } catch {
      // localStorage unavailable (private browsing) — ratio won't persist
    }
  }

  // ─── Drag handling ────────────────────────────────────────────────────────

  function onPointerDown(e: PointerEvent): void {
    e.preventDefault();
    isDragging = true;

    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent): void {
    if (!isDragging || !containerEl) return;

    const rect = containerEl.getBoundingClientRect();
    const containerWidth = rect.width;
    const x = e.clientX - rect.left;

    // Clamp to minimum pane widths
    const minRatio = MIN_PANE_WIDTH / containerWidth;
    const maxRatio = 1 - minRatio;
    const newRatio = Math.max(minRatio, Math.min(maxRatio, x / containerWidth));

    ratio = newRatio;
  }

  function onPointerUp(): void {
    if (!isDragging) return;
    isDragging = false;
    persistRatio();
  }
</script>

<div
  class="split-pane"
  class:dragging={isDragging}
  bind:this={containerEl}
>
  <div class="split-left" style="flex: {ratio} 1 0%;">
    {@render left()}
  </div>

  <div
    class="split-divider"
    role="separator"
    aria-orientation="vertical"
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onlostpointercapture={() => { if (isDragging) { isDragging = false; persistRatio(); } }}
    data-print="hide"
  ></div>

  <div class="split-right" style="flex: {1 - ratio} 1 0%;">
    {@render right()}
  </div>
</div>

<style>
  .split-pane {
    display: flex;
    flex: 1;
    overflow: hidden;
    min-height: 0;
  }

  .split-left,
  .split-right {
    overflow: hidden;
    min-width: 0;
  }

  /* ── Divider — the transformation boundary ── */

  .split-divider {
    width: 1px;
    flex-shrink: 0;
    background: var(--pencil);
    cursor: col-resize;
    position: relative;
    transition: background-color var(--duration-fast) var(--ease-out);
    /* Wider invisible hit area */
    padding: 0 3px;
    margin: 0 -3px;
    background-clip: content-box;
  }

  .split-divider:hover {
    background: var(--pencil-strong);
    background-clip: content-box;
  }

  /* While dragging: suppress text selection globally, keep divider highlighted */
  .dragging {
    cursor: col-resize;
    user-select: none;
  }

  .dragging .split-divider {
    background: var(--pencil-strong);
    background-clip: content-box;
  }
</style>

<script lang="ts">
  /**
   * Application toolbar — all action groups, responsive layout.
   *
   * Desktop (>=768px): full row with logical groups:
   *   [App Title | New] [Editor|Split|Preview] [Import|Export▾|Copy] [Share▾|Fork|Delete] [Sync] [Save State | Stats]
   *
   * Mobile (<768px): compact bar:
   *   [Editor|Split|Preview] [Share] [Save State] [...]
   *   Overflow menu: Import, Export, Copy, Fork, Delete, Sync, Stats
   *
   * Design system: borders-only depth, warm paper surface, ink text.
   * All values via CSS custom properties.
   */
  import type { ContentStats } from '../lib/stats';
  import type { ViewMode, SaveState, ThemeMode } from '../lib/types';
  import { importUrl } from '../lib/api';

  interface Props {
    viewMode: ViewMode;
    onViewModeChange: (mode: ViewMode) => void;
    syncScrollEnabled: boolean;
    onSyncScrollToggle: () => void;
    stats: ContentStats;
    saveState: SaveState;
    isNarrow?: boolean;
    isReadOnly?: boolean;
    themeMode?: ThemeMode;
    onThemeToggle?: () => void;
    // Actions
    onNew: () => void;
    onImport: () => void;
    onImportUrl: (content: string) => void;
    onExportMd: () => void;
    onExportHtml: () => void;
    onExportPdf: () => void;
    onCopyRendered: () => void;
    onShareEdit: () => void;
    onShareReadOnly: () => void;
    onFork: () => void;
    onDelete: () => void;
  }

  let {
    viewMode,
    onViewModeChange,
    syncScrollEnabled,
    onSyncScrollToggle,
    stats,
    saveState,
    isNarrow = false,
    isReadOnly = false,
    themeMode = 'system',
    onThemeToggle,
    onNew,
    onImport,
    onImportUrl,
    onExportMd,
    onExportHtml,
    onExportPdf,
    onCopyRendered,
    onShareEdit,
    onShareReadOnly,
    onFork,
    onDelete,
  }: Props = $props();

  // ─── Dropdown state ──────────────────────────────────────────────────────

  let openDropdown = $state<'import' | 'export' | 'share' | 'overflow' | null>(null);

  function toggleDropdown(name: 'import' | 'export' | 'share' | 'overflow'): void {
    openDropdown = openDropdown === name ? null : name;
    // Reset URL popover when closing import dropdown
    if (openDropdown !== 'import') {
      showUrlInput = false;
      urlInputValue = '';
      urlError = '';
      urlLoading = false;
    }
  }

  function closeDropdowns(): void {
    openDropdown = null;
    showUrlInput = false;
    urlInputValue = '';
    urlError = '';
    urlLoading = false;
  }

  /** Handle click on a dropdown item: run action + close. */
  function dropdownAction(fn: () => void): void {
    fn();
    closeDropdowns();
  }

  // ─── URL import state ───────────────────────────────────────────────────

  let showUrlInput = $state(false);
  let urlInputValue = $state('');
  let urlError = $state('');
  let urlLoading = $state(false);

  function openUrlInput(): void {
    showUrlInput = true;
    urlInputValue = '';
    urlError = '';
    urlLoading = false;
  }

  function validateUrl(value: string): string | null {
    if (!value.trim()) return 'Enter a URL';
    try {
      const parsed = new URL(value.trim());
      if (parsed.protocol !== 'https:') return 'Only HTTPS URLs are supported';
    } catch {
      return 'Invalid URL format';
    }
    return null;
  }

  async function handleUrlImport(): Promise<void> {
    const error = validateUrl(urlInputValue);
    if (error) {
      urlError = error;
      return;
    }
    urlError = '';
    urlLoading = true;
    try {
      const result = await importUrl(urlInputValue.trim());
      if ('error' in result) {
        urlError = result.error;
      } else {
        onImportUrl(result.content);
        closeDropdowns();
      }
    } catch {
      urlError = 'Failed to fetch URL';
    } finally {
      urlLoading = false;
    }
  }

  function handleUrlKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !urlLoading) {
      e.preventDefault();
      void handleUrlImport();
    }
  }

  // ─── Click-outside handling ──────────────────────────────────────────────

  function handleToolbarClick(e: MouseEvent): void {
    // If clicking on the toolbar background (not a button/menu), close dropdowns
    const target = e.target as HTMLElement;
    if (!target.closest('.dropdown') && !target.closest('.overflow-wrap')) {
      closeDropdowns();
    }
  }

  // Global Escape key closes dropdowns (handled by App.svelte's onDismiss,
  // but we also hook into it locally for immediate response)
  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && openDropdown) {
      closeDropdowns();
    }
  }

  // ─── Derived ──────────────────────────────────────────────────────────────

  const saveLabels: Record<SaveState, string> = {
    idle: '',
    saving: 'Saving\u2026',
    saved: 'Saved',
    error: 'Save error',
    readonly: 'Read-only',
  };

  let saveLabel = $derived(saveLabels[saveState]);

  let saveClass = $derived(
    saveState === 'error' ? 'save-error'
    : saveState === 'saved' ? 'save-success'
    : saveState === 'readonly' ? 'save-readonly'
    : ''
  );

  // Theme toggle: ☀ (sun) for dark mode (click → light), ☾ (moon) for light mode (click → system),
  // ◐ (half-circle) for system mode (click → opposite of computed)
  let themeIcon = $derived(themeMode === 'dark' ? '☀' : themeMode === 'light' ? '☾' : '◐');
  let themeTitle = $derived(
    themeMode === 'dark' ? 'Switch to light mode'
    : themeMode === 'light' ? 'Use system theme'
    : 'Toggle dark mode'
  );
</script>

<svelte:window onclick={handleToolbarClick} onkeydown={handleKeydown} />

<!-- svelte-ignore a11y_interactive_supports_focus -->
<header class="toolbar" role="toolbar" data-print="hide">

  {#if !isNarrow}
    <!-- ═══════════════════════════════════════════════════════
         DESKTOP LAYOUT
         ═══════════════════════════════════════════════════════ -->

    <!-- Left: App title + New -->
    <div class="toolbar-group">
      <span class="app-title">Markdown Viewer</span>
      <button class="tool-btn" onclick={onNew} title="New session" aria-label="New session">New</button>
    </div>

    <!-- Center-left: View modes -->
    <div class="toolbar-group">
      <div class="view-toggle" role="group" aria-label="View mode">
        <button
          class="toggle-btn"
          class:active={viewMode === 'editor'}
          onclick={() => onViewModeChange('editor')}
          aria-pressed={viewMode === 'editor'}
          aria-label="Editor view"
          title="Editor only (Cmd+\)"
        >Editor</button>
        <button
          class="toggle-btn"
          class:active={viewMode === 'split'}
          onclick={() => onViewModeChange('split')}
          aria-pressed={viewMode === 'split'}
          aria-label="Split view"
          title="Split view (Cmd+\)"
        >Split</button>
        <button
          class="toggle-btn"
          class:active={viewMode === 'preview'}
          onclick={() => onViewModeChange('preview')}
          aria-pressed={viewMode === 'preview'}
          aria-label="Preview view"
          title="Preview only (Cmd+\)"
        >Preview</button>
      </div>
    </div>

    <!-- Center: File actions -->
    <div class="toolbar-group">
      {#if !isReadOnly}
        <!-- Import dropdown -->
        <div class="dropdown">
          <button
            class="tool-btn"
            class:active={openDropdown === 'import'}
            onclick={() => toggleDropdown('import')}
            aria-expanded={openDropdown === 'import'}
            aria-haspopup="true"
            aria-label="Import"
          >Import ▾</button>
          {#if openDropdown === 'import'}
            <div class="dropdown-menu import-menu" role="menu">
              {#if !showUrlInput}
                <button class="dropdown-item" role="menuitem" onclick={() => dropdownAction(onImport)}>From file</button>
                <button class="dropdown-item" role="menuitem" onclick={openUrlInput}>From URL</button>
              {:else}
                <div class="url-input-panel" role="none">
                  <!-- svelte-ignore a11y_autofocus -->
                  <input
                    class="url-input"
                    type="url"
                    placeholder="https://raw.githubusercontent.com/..."
                    bind:value={urlInputValue}
                    onkeydown={handleUrlKeydown}
                    disabled={urlLoading}
                    autofocus
                  />
                  <button
                    class="url-import-btn"
                    onclick={() => { void handleUrlImport(); }}
                    disabled={urlLoading}
                  >{urlLoading ? 'Importing\u2026' : 'Import'}</button>
                  {#if urlError}
                    <p class="url-error">{urlError}</p>
                  {/if}
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {/if}

      <!-- Export dropdown -->
      <div class="dropdown">
        <button
          class="tool-btn"
          class:active={openDropdown === 'export'}
          onclick={() => toggleDropdown('export')}
          aria-expanded={openDropdown === 'export'}
          aria-haspopup="true"
          aria-label="Export"
        >Export ▾</button>
        {#if openDropdown === 'export'}
          <div class="dropdown-menu" role="menu">
            <button class="dropdown-item" role="menuitem" onclick={() => dropdownAction(onExportMd)}>Markdown (.md)</button>
            <button class="dropdown-item" role="menuitem" onclick={() => dropdownAction(onExportHtml)}>HTML (.html)</button>
            <button class="dropdown-item" role="menuitem" onclick={() => dropdownAction(onExportPdf)}>PDF (print)</button>
          </div>
        {/if}
      </div>

      <button class="tool-btn" onclick={onCopyRendered} title="Copy rendered (Cmd+Shift+C)" aria-label="Copy rendered content">Copy</button>
    </div>

    <!-- Center-right: Collaboration -->
    <div class="toolbar-group">
      <!-- Share dropdown -->
      <div class="dropdown">
        <button
          class="tool-btn"
          class:active={openDropdown === 'share'}
          onclick={() => toggleDropdown('share')}
          aria-expanded={openDropdown === 'share'}
          aria-haspopup="true"
          aria-label="Share"
        >Share ▾</button>
        {#if openDropdown === 'share'}
          <div class="dropdown-menu" role="menu">
            {#if !isReadOnly}
              <button class="dropdown-item" role="menuitem" onclick={() => dropdownAction(onShareEdit)}>Copy edit link</button>
            {/if}
            <button class="dropdown-item" role="menuitem" onclick={() => dropdownAction(onShareReadOnly)}>Copy read-only link</button>
          </div>
        {/if}
      </div>

      <button class="tool-btn" onclick={onFork} title="Fork session" aria-label="Fork session">Fork</button>

      {#if !isReadOnly}
        <button class="tool-btn delete-btn" onclick={onDelete} title="Delete session" aria-label="Delete session">Delete</button>
      {/if}
    </div>

    <!-- Right: Sync + Theme + Save + Stats -->
    <div class="toolbar-group toolbar-right">
      {#if viewMode === 'split'}
        <button
          class="sync-btn"
          class:active={syncScrollEnabled}
          onclick={onSyncScrollToggle}
          title="Toggle sync scrolling"
          aria-label="Toggle sync scrolling"
          aria-pressed={syncScrollEnabled}
        >Sync</button>
      {/if}

      {#if onThemeToggle}
        <button
          class="theme-btn"
          onclick={onThemeToggle}
          title={themeTitle}
          aria-label={themeTitle}
        >{themeIcon}</button>
      {/if}

      {#if isReadOnly}
        <span class="readonly-badge">Read-only</span>
      {:else if saveLabel}
        <span class="save-indicator {saveClass}">{saveLabel}</span>
      {/if}

      <span class="stats">
        {stats.words} words · {stats.chars} chars · {stats.readTime} min read
      </span>
    </div>

  {:else}
    <!-- ═══════════════════════════════════════════════════════
         MOBILE LAYOUT
         ═══════════════════════════════════════════════════════ -->

    <!-- Left: View modes -->
    <div class="toolbar-group">
      <div class="view-toggle" role="group" aria-label="View mode">
        <button
          class="toggle-btn"
          class:active={viewMode === 'editor'}
          onclick={() => onViewModeChange('editor')}
          aria-pressed={viewMode === 'editor'}
          aria-label="Editor view"
          title="Editor only"
        >Editor</button>
        <button
          class="toggle-btn"
          class:active={viewMode === 'preview'}
          onclick={() => onViewModeChange('preview')}
          aria-pressed={viewMode === 'preview'}
          aria-label="Preview view"
          title="Preview only"
        >Preview</button>
      </div>
    </div>

    <!-- Center: Share + Save -->
    <div class="toolbar-group">
      {#if !isReadOnly}
        <button class="tool-btn tool-btn-compact" onclick={onShareEdit} title="Copy edit link" aria-label="Share">Share</button>
      {:else}
        <button class="tool-btn tool-btn-compact" onclick={onShareReadOnly} title="Copy read-only link" aria-label="Share">Share</button>
      {/if}

      {#if isReadOnly}
        <span class="readonly-badge">Read-only</span>
      {:else if saveLabel}
        <span class="save-indicator {saveClass}">{saveLabel}</span>
      {/if}
    </div>

    <!-- Right: Overflow menu -->
    <div class="toolbar-group overflow-wrap">
      <button
        class="tool-btn overflow-trigger"
        class:active={openDropdown === 'overflow'}
        onclick={() => toggleDropdown('overflow')}
        aria-expanded={openDropdown === 'overflow'}
        aria-haspopup="true"
        aria-label="More actions"
        title="More actions"
      >&#x22EF;</button>

      {#if openDropdown === 'overflow'}
        <div class="dropdown-menu dropdown-menu-right overflow-menu" role="menu">
          <button class="dropdown-item" role="menuitem" onclick={() => dropdownAction(onNew)}>New session</button>

          {#if !isReadOnly}
            <button class="dropdown-item" role="menuitem" onclick={() => dropdownAction(onImport)}>Import from file</button>
            {#if !showUrlInput}
              <button class="dropdown-item" role="menuitem" onclick={openUrlInput}>Import from URL</button>
            {:else}
              <div class="url-input-panel url-input-panel-mobile" role="none">
                <!-- svelte-ignore a11y_autofocus -->
                <input
                  class="url-input"
                  type="url"
                  placeholder="https://..."
                  bind:value={urlInputValue}
                  onkeydown={handleUrlKeydown}
                  disabled={urlLoading}
                  autofocus
                />
                <button
                  class="url-import-btn"
                  onclick={() => { void handleUrlImport(); }}
                  disabled={urlLoading}
                >{urlLoading ? 'Importing\u2026' : 'Import'}</button>
                {#if urlError}
                  <p class="url-error">{urlError}</p>
                {/if}
              </div>
            {/if}
          {/if}

          <div class="dropdown-divider" role="separator"></div>

          <button class="dropdown-item" role="menuitem" onclick={() => dropdownAction(onExportMd)}>Export Markdown</button>
          <button class="dropdown-item" role="menuitem" onclick={() => dropdownAction(onExportHtml)}>Export HTML</button>
          <button class="dropdown-item" role="menuitem" onclick={() => dropdownAction(onExportPdf)}>Export PDF</button>
          <button class="dropdown-item" role="menuitem" onclick={() => dropdownAction(onCopyRendered)}>Copy rendered</button>

          <div class="dropdown-divider" role="separator"></div>

          {#if !isReadOnly}
            <button class="dropdown-item" role="menuitem" onclick={() => dropdownAction(onShareEdit)}>Copy edit link</button>
          {/if}
          <button class="dropdown-item" role="menuitem" onclick={() => dropdownAction(onShareReadOnly)}>Copy read-only link</button>
          <button class="dropdown-item" role="menuitem" onclick={() => dropdownAction(onFork)}>Fork session</button>

          {#if !isReadOnly}
            <div class="dropdown-divider" role="separator"></div>
            <button class="dropdown-item dropdown-item-danger" role="menuitem" onclick={() => dropdownAction(onDelete)}>Delete session</button>
          {/if}

          <div class="dropdown-divider" role="separator"></div>

          <button class="dropdown-item" role="menuitem" onclick={() => dropdownAction(onSyncScrollToggle)}>
            Sync scroll {syncScrollEnabled ? '(on)' : '(off)'}
          </button>

          {#if onThemeToggle}
            <button class="dropdown-item" role="menuitem" onclick={() => { if (onThemeToggle) dropdownAction(onThemeToggle); }}>
              {themeIcon} {themeMode === 'dark' ? 'Light mode' : themeMode === 'light' ? 'System theme' : 'Toggle theme'}
            </button>
          {/if}

          <div class="dropdown-meta">
            {stats.words}w · {stats.chars}c · {stats.readTime}m read
          </div>
        </div>
      {/if}
    </div>
  {/if}
</header>

<style>
  /* ── Toolbar shell ── */

  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-sm) var(--space-base);
    background: var(--paper-above);
    border-bottom: 1px solid var(--pencil);
    flex-shrink: 0;
    z-index: var(--z-toolbar);
    gap: var(--space-sm);
    min-height: 44px;
  }

  /* ── Groups ── */

  .toolbar-group {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
  }

  .toolbar-right {
    gap: var(--space-sm);
    justify-content: flex-end;
    margin-left: auto;
  }

  /* ── App title ── */

  .app-title {
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-wide);
    color: var(--ink-secondary);
    text-transform: uppercase;
    white-space: nowrap;
    margin-right: var(--space-xs);
  }

  /* ── View mode toggle ── */

  .view-toggle {
    display: flex;
    border: 1px solid var(--pencil);
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  .toggle-btn {
    background: none;
    border: none;
    border-right: 1px solid var(--pencil);
    padding: var(--space-xs) var(--space-sm);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--ink-muted);
    cursor: pointer;
    transition:
      color var(--duration-fast) var(--ease-out),
      background-color var(--duration-fast) var(--ease-out);
    line-height: var(--leading-snug);
  }

  .toggle-btn:last-child {
    border-right: none;
  }

  .toggle-btn:hover {
    color: var(--ink);
    background: var(--paper-inset);
  }

  .toggle-btn.active {
    color: var(--ink);
    background: var(--paper-inset);
    font-weight: var(--weight-semibold);
  }

  /* ── Tool buttons (generic action buttons) ── */

  .tool-btn {
    background: none;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    padding: var(--space-xs) var(--space-sm);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--ink-muted);
    cursor: pointer;
    white-space: nowrap;
    transition:
      color var(--duration-fast) var(--ease-out),
      background-color var(--duration-fast) var(--ease-out),
      border-color var(--duration-fast) var(--ease-out);
    line-height: var(--leading-snug);
  }

  .tool-btn:hover {
    color: var(--ink);
    background: var(--paper-inset);
  }

  .tool-btn.active {
    color: var(--ink);
    background: var(--paper-inset);
    border-color: var(--pencil);
  }

  .tool-btn-compact {
    padding: var(--space-xs) var(--space-xs);
    font-size: var(--text-xs);
  }

  /* ── Delete button — destructive styling ── */

  .delete-btn {
    color: var(--mark-error);
  }

  .delete-btn:hover {
    color: var(--mark-error);
    background: color-mix(in srgb, var(--mark-error) 8%, transparent);
  }

  /* ── Sync scroll button ── */

  .sync-btn {
    background: none;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    padding: var(--space-xs) var(--space-sm);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--ink-muted);
    cursor: pointer;
    transition:
      color var(--duration-fast) var(--ease-out),
      background-color var(--duration-fast) var(--ease-out),
      border-color var(--duration-fast) var(--ease-out);
    line-height: var(--leading-snug);
  }

  .sync-btn:hover {
    color: var(--ink);
    background: var(--paper-inset);
  }

  .sync-btn.active {
    color: var(--margin-note);
    border-color: var(--pencil);
    background: var(--paper-inset);
  }

  /* ── Theme toggle button ── */

  .theme-btn {
    background: none;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    padding: var(--space-xs) var(--space-sm);
    font-size: var(--text-md);
    color: var(--ink-muted);
    cursor: pointer;
    line-height: 1;
    transition:
      color var(--duration-fast) var(--ease-out),
      background-color var(--duration-fast) var(--ease-out),
      border-color var(--duration-fast) var(--ease-out);
  }

  .theme-btn:hover {
    color: var(--ink);
    background: var(--paper-inset);
  }

  /* ── Dropdown ── */

  .dropdown {
    position: relative;
  }

  .dropdown-menu {
    position: absolute;
    top: calc(100% + var(--space-xs));
    left: 0;
    min-width: 160px;
    background: var(--paper-overlay);
    border: 1px solid var(--pencil);
    border-radius: var(--radius-md);
    padding: var(--space-xs) 0;
    z-index: var(--z-dropdown);
    animation: dropdown-in var(--duration-fast) var(--ease-out);
  }

  .dropdown-menu-right {
    left: auto;
    right: 0;
  }

  .dropdown-item {
    display: block;
    width: 100%;
    background: none;
    border: none;
    padding: var(--space-xs) var(--space-md);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    font-weight: var(--weight-normal);
    color: var(--ink);
    cursor: pointer;
    text-align: left;
    white-space: nowrap;
    transition:
      color var(--duration-fast) var(--ease-out),
      background-color var(--duration-fast) var(--ease-out);
    line-height: var(--leading-snug);
  }

  .dropdown-item:hover {
    background: var(--paper-inset);
  }

  .dropdown-item:focus-visible {
    background: var(--paper-inset);
    outline: none;
  }

  .dropdown-item-danger {
    color: var(--mark-error);
  }

  .dropdown-item-danger:hover {
    background: color-mix(in srgb, var(--mark-error) 8%, transparent);
  }

  .dropdown-divider {
    height: 1px;
    background: var(--pencil);
    margin: var(--space-xs) 0;
  }

  .dropdown-meta {
    padding: var(--space-xs) var(--space-md);
    font-size: var(--text-xs);
    color: var(--ink-muted);
    font-variant-numeric: tabular-nums;
  }

  @keyframes dropdown-in {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  /* ── Overflow trigger ── */

  .overflow-wrap {
    position: relative;
  }

  .overflow-trigger {
    font-size: var(--text-md);
    letter-spacing: 0.1em;
    padding: var(--space-xs) var(--space-sm);
  }

  .overflow-menu {
    min-width: 180px;
  }

  /* ── Save indicator ── */

  .save-indicator {
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
    color: var(--ink-muted);
    white-space: nowrap;
  }

  .save-success {
    color: var(--mark-success);
  }

  .save-error {
    color: var(--mark-error);
  }

  .save-readonly {
    color: var(--ink-faint);
  }

  /* ── Read-only badge ── */

  .readonly-badge {
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    color: var(--ink-faint);
    background: var(--paper-inset);
    border: 1px solid var(--pencil);
    border-radius: var(--radius-sm);
    padding: 1px var(--space-xs);
    white-space: nowrap;
    letter-spacing: var(--tracking-wide);
    text-transform: uppercase;
  }

  /* ── Stats ── */

  .stats {
    font-size: var(--text-xs);
    color: var(--ink-muted);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  /* ── URL import panel ── */

  .import-menu {
    min-width: 180px;
  }

  .url-input-panel {
    padding: var(--space-sm) var(--space-md);
    display: flex;
    flex-direction: column;
    gap: var(--space-xs);
    min-width: 280px;
  }

  .url-input-panel-mobile {
    min-width: 0;
  }

  .url-input {
    width: 100%;
    background: var(--paper-inset);
    border: 1px solid var(--pencil-strong);
    border-radius: var(--radius-sm);
    padding: var(--space-xs) var(--space-sm);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    color: var(--ink);
    line-height: var(--leading-snug);
    transition: border-color var(--duration-fast) var(--ease-out);
  }

  .url-input::placeholder {
    color: var(--ink-faint);
  }

  .url-input:focus {
    outline: none;
    border-color: var(--pencil-focus);
  }

  .url-input:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .url-import-btn {
    align-self: flex-end;
    background: var(--paper-inset);
    border: 1px solid var(--pencil);
    border-radius: var(--radius-sm);
    padding: var(--space-xs) var(--space-sm);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--ink);
    cursor: pointer;
    white-space: nowrap;
    transition:
      color var(--duration-fast) var(--ease-out),
      background-color var(--duration-fast) var(--ease-out),
      border-color var(--duration-fast) var(--ease-out);
    line-height: var(--leading-snug);
  }

  .url-import-btn:hover:not(:disabled) {
    background: var(--pencil-subtle);
    border-color: var(--pencil-strong);
  }

  .url-import-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .url-error {
    font-size: var(--text-xs);
    color: var(--mark-error);
    margin: 0;
    line-height: var(--leading-snug);
    word-break: break-word;
    white-space: normal;
  }
</style>

<script lang="ts">
  /**
   * App shell — the orchestrator.
   *
   * Owns the single source of truth (markdown content), manages routing,
   * edit tokens, auto-save, view modes, sync scrolling, and composes the
   * Toolbar + SplitPane layout.
   *
   * Routing:
   *   `/`            → new session (placeholder content, editable)
   *   `/:id`         → existing session (read-only unless token found)
   *   `/:id#token=…` → existing session (extract token, store, clean URL, editable)
   */
  import { onMount } from 'svelte';
  import { nanoid } from 'nanoid';
  import Editor from './components/Editor.svelte';
  import Preview from './components/Preview.svelte';
  import SplitPane from './components/SplitPane.svelte';
  import Toolbar from './components/Toolbar.svelte';
  import { computeStats } from './lib/stats';
  import { setupShortcuts, cycleViewMode } from './lib/shortcuts';
  import { getSession, saveSession, deleteSession } from './lib/api';
  import type { CreateResponse } from './lib/api';
  import { extractAndCleanToken, getStoredToken, storeToken, removeToken } from './lib/tokens';
  import { createAutosave } from './lib/autosave';
  import { initTurnstile, getTurnstileToken, isTurnstileConfigured } from './lib/turnstile';
  import { downloadMarkdown, downloadHtml, printToPdf, copyRendered } from './lib/export';
  import { extractTitle } from '../shared/markdown';
  import { PLACEHOLDER_MARKDOWN } from './lib/placeholder';
  import type { AutosaveHandle } from './lib/autosave';
  import type { ViewMode, SaveState, ThemeMode } from './lib/types';

  // ─── Constants ─────────────────────────────────────────────────────────────

  const VIEW_MODE_KEY = 'markdown-viewer-view-mode';
  const THEME_KEY = 'markdown-viewer-theme';
  const NARROW_BREAKPOINT = 768;
  const SESSION_ID_RE = /^[A-Za-z0-9_-]{12}$/;
  const DELETE_UNDO_MS = 10_000;
  const FILE_ACCEPT = '.md,.markdown,.txt,.text';
  const MAX_FILE_SIZE = 524_288; // 512 KB

  // ─── State ─────────────────────────────────────────────────────────────────

  let markdown = $state(PLACEHOLDER_MARKDOWN);
  let viewMode = $state<ViewMode>('split');
  let syncScroll = $state(true);
  let saveState = $state<SaveState>('idle');
  let isReadOnly = $state(false);
  let isNarrow = $state(false);
  let themeMode = $state<ThemeMode>('system');

  // Toast state
  let toastMessage = $state('');
  let toastType = $state<'info' | 'success' | 'error'>('info');
  let toastAction = $state<{ label: string; handler: () => void } | null>(null);

  // Session state — not reactive via $state because they don't drive UI rendering
  let sessionId = '';
  let editToken: string | null = null;
  let autosave: AutosaveHandle | undefined;

  // Delete undo state
  let deleteUndoContent: string | null = null;
  let deleteUndoTimer: ReturnType<typeof setTimeout> | undefined;

  // Hidden file input for import
  let fileInputEl: HTMLInputElement | undefined;

  // ─── Component refs ────────────────────────────────────────────────────────

  let editorRef = $state<Editor | undefined>();
  let previewRef = $state<Preview | undefined>();

  // Scroll sync feedback-loop prevention: when editor scrolls → set source='editor'
  // → preview ignores its own scroll event → 50ms timeout clears the flag.
  // Without this, setting scrollTop on one pane triggers its scroll event,
  // which sets scrollTop on the other, creating infinite ping-pong.
  let scrollSource: 'editor' | 'preview' | null = null;
  let scrollTimeout: ReturnType<typeof setTimeout> | undefined;

  // ─── Derived ───────────────────────────────────────────────────────────────

  let stats = $derived(computeStats(markdown));

  // ─── Toast helper ─────────────────────────────────────────────────────────

  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  function showToast(
    message: string,
    options: {
      type?: 'info' | 'success' | 'error';
      durationMs?: number;
      action?: { label: string; handler: () => void };
    } = {},
  ): void {
    const { type = 'info', durationMs = 4000, action = null } = options;
    toastMessage = message;
    toastType = type;
    toastAction = action;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      dismissToast();
    }, durationMs);
  }

  function dismissToast(): void {
    toastMessage = '';
    toastAction = null;
    clearTimeout(toastTimer);
  }

  // ─── Routing ──────────────────────────────────────────────────────────────

  function parseRoute(): string | null {
    const pathname = window.location.pathname;
    if (pathname === '/' || pathname === '') return null;
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length === 1 && SESSION_ID_RE.test(segments[0])) {
      return segments[0];
    }
    return null;
  }

  function getBootstrapData(): { content: string } | null {
    const el = document.getElementById('__DATA__');
    if (!el?.textContent) return null;
    try {
      const data = JSON.parse(el.textContent) as { content?: string };
      if (typeof data.content === 'string') {
        return { content: data.content };
      }
    } catch {
      // Malformed bootstrap data — fall through to API fetch
    }
    return null;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  onMount(() => {
    // --- Routing: determine session mode ---
    const routeId = parseRoute();

    if (routeId === null) {
      sessionId = nanoid(12);
      editToken = null;
      isReadOnly = false;
      initTurnstile();
    } else {
      sessionId = routeId;
      const hashToken = extractAndCleanToken();
      if (hashToken) {
        storeToken(sessionId, hashToken);
        editToken = hashToken;
      } else {
        editToken = getStoredToken(sessionId);
      }
      isReadOnly = editToken === null;

      const bootstrap = getBootstrapData();
      if (bootstrap) {
        markdown = bootstrap.content;
      } else {
        void loadSession(routeId);
      }
    }

    // --- View mode ---
    try {
      const savedMode = localStorage.getItem(VIEW_MODE_KEY);
      if (savedMode === 'editor' || savedMode === 'split' || savedMode === 'preview') {
        viewMode = savedMode;
      }
    } catch {
      // localStorage unavailable — use default view mode
    }

    // --- Theme mode ---
    // Read from localStorage (main.ts already applied the data-theme attribute)
    try {
      const savedTheme = localStorage.getItem(THEME_KEY);
      if (savedTheme === 'light' || savedTheme === 'dark') {
        themeMode = savedTheme;
      }
    } catch {
      // localStorage unavailable — follow system preference
    }

    if (isReadOnly) {
      applyReadOnlyViewMode();
    }

    // Track window width for responsive behavior
    function checkWidth(): void {
      const narrow = window.innerWidth < NARROW_BREAKPOINT;
      if (narrow !== isNarrow) {
        isNarrow = narrow;
        if (narrow && viewMode === 'split') {
          viewMode = isReadOnly ? 'preview' : 'editor';
        }
      }
    }
    checkWidth();
    window.addEventListener('resize', checkWidth);

    // --- Auto-save ---
    if (isReadOnly) {
      saveState = 'readonly';
    } else {
      autosave = createAutosave({
        onStateChange(state) {
          saveState = state;
        },
        onSessionCreated(id, token) {
          editToken = token;
          storeToken(id, token);
          history.replaceState(null, '', `/${id}`);
        },
      });
    }

    // --- Keyboard shortcuts ---
    const cleanupShortcuts = setupShortcuts({
      onSave() {
        if (autosave && !isReadOnly) {
          void autosave.flush();
        }
      },
      onCopyRendered() {
        void handleCopyRendered();
      },
      onCycleViewMode() {
        handleViewModeChange(cycleViewMode(viewMode));
      },
      onDismiss() {
        dismissToast();
      },
    });

    return () => {
      window.removeEventListener('resize', checkWidth);
      cleanupShortcuts();
      autosave?.destroy();
      if (scrollTimeout) clearTimeout(scrollTimeout);
      clearTimeout(toastTimer);
      clearTimeout(deleteUndoTimer);
    };
  });

  // ─── Session loading ──────────────────────────────────────────────────────

  async function loadSession(id: string): Promise<void> {
    try {
      const data = await getSession(id);
      if (data === null) {
        showToast('Session not found or expired');
        history.replaceState(null, '', '/');
        sessionId = nanoid(12);
        editToken = null;
        isReadOnly = false;
        markdown = PLACEHOLDER_MARKDOWN;
        saveState = 'idle';

        autosave?.destroy();
        autosave = createAutosave({
          onStateChange(state) {
            saveState = state;
          },
          onSessionCreated(newId, token) {
            editToken = token;
            storeToken(newId, token);
            history.replaceState(null, '', `/${newId}`);
          },
        });
        return;
      }

      markdown = data.content;
    } catch {
      showToast('Failed to load session', { type: 'error' });
    }
  }

  // ─── Read-only view mode ──────────────────────────────────────────────────

  function applyReadOnlyViewMode(): void {
    const narrow = window.innerWidth < NARROW_BREAKPOINT;
    viewMode = narrow ? 'preview' : 'split';
  }

  // ─── View mode ─────────────────────────────────────────────────────────────

  function handleViewModeChange(mode: ViewMode): void {
    if (isNarrow && mode === 'split') {
      mode = 'preview';
    }
    viewMode = mode;
    try { localStorage.setItem(VIEW_MODE_KEY, mode); } catch { /* best effort */ }
  }

  // ─── Theme toggle ──────────────────────────────────────────────────────────

  /**
   * Detect the currently active theme (accounting for system preference).
   * Returns 'light' or 'dark' based on what the user actually sees.
   */
  function getEffectiveTheme(): 'light' | 'dark' {
    if (themeMode !== 'system') return themeMode;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  /**
   * Cycle theme: system → dark → light → system.
   * First click leaves system mode to the opposite of the current computed theme.
   */
  function handleThemeToggle(): void {
    let next: ThemeMode;
    if (themeMode === 'system') {
      // Leave system mode → opposite of current computed
      next = getEffectiveTheme() === 'dark' ? 'light' : 'dark';
    } else if (themeMode === 'dark') {
      next = 'light';
    } else {
      // light → system
      next = 'system';
    }
    themeMode = next;

    if (next === 'system') {
      document.documentElement.removeAttribute('data-theme');
      try { localStorage.removeItem(THEME_KEY); } catch { /* best effort */ }
    } else {
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem(THEME_KEY, next); } catch { /* best effort */ }
    }
  }

  // ─── Sync scrolling ───────────────────────────────────────────────────────

  function handleEditorScroll(ratio: number): void {
    if (!syncScroll || viewMode !== 'split') return;
    if (scrollSource === 'preview') return;

    scrollSource = 'editor';
    previewRef?.setScrollRatio(ratio);

    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => { scrollSource = null; }, 50);
  }

  function handlePreviewScroll(ratio: number): void {
    if (!syncScroll || viewMode !== 'split') return;
    if (scrollSource === 'editor') return;

    scrollSource = 'preview';
    editorRef?.setScrollRatio(ratio);

    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => { scrollSource = null; }, 50);
  }

  // ─── Content change ────────────────────────────────────────────────────────

  function handleContentChange(content: string): void {
    markdown = content;
    autosave?.save(sessionId, content, editToken);
  }

  // ─── Action handlers ──────────────────────────────────────────────────────

  /** Navigate to root for a fresh session. */
  function handleNew(): void {
    window.location.href = '/';
  }

  /** Open file picker for markdown import. */
  function handleImportClick(): void {
    fileInputEl?.click();
  }

  /** Process selected file from file picker. */
  function handleFileSelected(e: Event): void {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    // Size check before reading
    if (file.size > MAX_FILE_SIZE) {
      showToast('File too large (max 512 KB)', { type: 'error' });
      input.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const content = reader.result as string;

      // Binary content check
      if (content.includes('\0')) {
        showToast('File appears to be binary, not text', { type: 'error' });
        input.value = '';
        return;
      }

      // Confirm before replacing if editor has non-placeholder content
      if (markdown !== PLACEHOLDER_MARKDOWN && markdown.trim().length > 0) {
        if (!confirm('Replace current content with imported file?')) {
          // Reset the input so the same file can be re-selected
          input.value = '';
          return;
        }
      }
      markdown = content;
      // Trigger autosave with new content
      autosave?.save(sessionId, content, editToken);
      showToast('File imported', { type: 'success' });
      // Reset input for re-import
      input.value = '';
    };
    reader.onerror = () => {
      showToast('Failed to read file', { type: 'error' });
      input.value = '';
    };
    reader.readAsText(file);
  }

  /** Handle content imported from a URL (called by Toolbar after successful fetch). */
  function handleImportUrl(content: string): void {
    // Confirm before replacing if editor has non-placeholder content
    if (markdown !== PLACEHOLDER_MARKDOWN && markdown.trim().length > 0) {
      if (!confirm('Replace current content with imported URL?')) {
        return;
      }
    }
    markdown = content;
    autosave?.save(sessionId, content, editToken);
    showToast('URL imported', { type: 'success' });
  }

  /** Download markdown as .md file. */
  function handleExportMd(): void {
    downloadMarkdown(markdown, sessionId);
  }

  /** Download rendered HTML as standalone .html file. */
  function handleExportHtml(): void {
    downloadHtml(markdown, extractTitle(markdown));
  }

  /** Print to PDF via browser print dialog. */
  function handleExportPdf(): void {
    printToPdf();
  }

  /** Copy rendered markdown as rich text. */
  async function handleCopyRendered(): Promise<void> {
    const ok = await copyRendered(markdown);
    if (ok) {
      showToast('Copied!', { type: 'success' });
    } else {
      showToast('Failed to copy', { type: 'error' });
    }
  }

  /**
   * Ensure the current content is saved and we have a session ID.
   * Returns true if ready to share, false if save failed.
   */
  async function ensureSessionSaved(): Promise<boolean> {
    if (editToken) return true;

    // Flush autosave to create the session
    if (autosave) {
      // First make sure there's a pending save queued
      autosave.save(sessionId, markdown, editToken);
      await autosave.flush();
    }

    // After flush, editToken should be set by onSessionCreated callback
    return editToken !== null;
  }

  /** Copy edit link to clipboard. */
  async function handleShareEdit(): Promise<void> {
    const ready = await ensureSessionSaved();
    if (!ready) {
      showToast('Save first to share', { type: 'error' });
      return;
    }

    const url = `${window.location.origin}/${sessionId}#token=${editToken}`;
    try {
      await navigator.clipboard.writeText(url);
      showToast('Edit link copied!', { type: 'success' });
    } catch {
      showToast('Failed to copy link', { type: 'error' });
    }
  }

  /** Copy read-only link to clipboard. */
  async function handleShareReadOnly(): Promise<void> {
    const ready = await ensureSessionSaved();
    if (!ready) {
      showToast('Save first to share', { type: 'error' });
      return;
    }

    const url = `${window.location.origin}/${sessionId}`;
    try {
      await navigator.clipboard.writeText(url);
      showToast('Read-only link copied!', { type: 'success' });
    } catch {
      showToast('Failed to copy link', { type: 'error' });
    }
  }

  /**
   * Create a new session with the given content: Turnstile check → save → store token.
   * Never throws — returns the new session info, or `null` on any failure.
   */
  async function createNewSession(content: string): Promise<{ id: string; editToken: string } | null> {
    try {
      const newId = nanoid(12);
      let turnstileToken: string | null | undefined;
      if (isTurnstileConfigured()) {
        turnstileToken = await getTurnstileToken();
      }
      const result = await saveSession(newId, content, undefined, turnstileToken);
      if ('editToken' in result) {
        const created = result as CreateResponse;
        storeToken(newId, created.editToken);
        return { id: newId, editToken: created.editToken };
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Fork: create new session with current content. */
  async function handleFork(): Promise<void> {
    const created = await createNewSession(markdown);
    if (!created) {
      showToast('Failed to fork session', { type: 'error' });
      return;
    }
    window.location.href = `/${created.id}`;
  }

  /** Delete with confirm and 10-second undo window. */
  async function handleDelete(): Promise<void> {
    if (!editToken) return;

    if (!confirm('Delete this session? You\'ll have 10 seconds to undo.')) {
      return;
    }

    // Hold content in memory for undo
    const savedContent = markdown;
    const savedSessionId = sessionId;

    try {
      await deleteSession(savedSessionId, editToken);
    } catch {
      showToast('Failed to delete session', { type: 'error' });
      return;
    }

    // Clean up token for deleted session
    removeToken(savedSessionId);
    autosave?.destroy();
    autosave = undefined;

    // Store content for undo
    deleteUndoContent = savedContent;

    // Show undo toast — use a longer duration than the undo window so the
    // toast stays visible until the deleteUndoTimer handles both dismissal
    // and redirect. Prevents a gap where the Undo button disappears before redirect.
    showToast('Session deleted.', {
      type: 'info',
      durationMs: DELETE_UNDO_MS + 1000,
      action: {
        label: 'Undo',
        handler: () => { void handleDeleteUndo(); },
      },
    });

    // Set timer: if undo not clicked, dismiss toast and redirect to /
    clearTimeout(deleteUndoTimer);
    deleteUndoTimer = setTimeout(() => {
      deleteUndoContent = null;
      dismissToast();
      window.location.href = '/';
    }, DELETE_UNDO_MS);
  }

  /** Undo a delete: re-create session with held content. */
  async function handleDeleteUndo(): Promise<void> {
    clearTimeout(deleteUndoTimer);
    dismissToast();

    const content = deleteUndoContent;
    deleteUndoContent = null;

    if (!content) {
      window.location.href = '/';
      return;
    }

    const created = await createNewSession(content);
    if (!created) {
      showToast('Failed to restore session', { type: 'error' });
      // Still redirect to / since original is deleted
      setTimeout(() => { window.location.href = '/'; }, 2000);
      return;
    }
    // Navigate to restored session
    window.location.href = `/${created.id}`;
  }
</script>

<!-- Hidden file input for import -->
<input
  bind:this={fileInputEl}
  type="file"
  accept={FILE_ACCEPT}
  onchange={handleFileSelected}
  style="display: none"
  aria-hidden="true"
  tabindex="-1"
/>

<div class="app-shell">
  <Toolbar
    {viewMode}
    onViewModeChange={handleViewModeChange}
    syncScrollEnabled={syncScroll}
    onSyncScrollToggle={() => { syncScroll = !syncScroll; }}
    {stats}
    {saveState}
    {isNarrow}
    {isReadOnly}
    onNew={handleNew}
    onImport={handleImportClick}
    onImportUrl={handleImportUrl}
    onExportMd={handleExportMd}
    onExportHtml={handleExportHtml}
    onExportPdf={handleExportPdf}
    onCopyRendered={() => { void handleCopyRendered(); }}
    onShareEdit={() => { void handleShareEdit(); }}
    onShareReadOnly={() => { void handleShareReadOnly(); }}
    onFork={() => { void handleFork(); }}
    onDelete={() => { void handleDelete(); }}
    {themeMode}
    onThemeToggle={handleThemeToggle}
  />

  <main class="workspace">
    {#if viewMode === 'split'}
      <SplitPane>
        {#snippet left()}
          <Editor
            bind:this={editorRef}
            content={markdown}
            readonly={isReadOnly}
            onchange={handleContentChange}
            onscroll={handleEditorScroll}
          />
        {/snippet}
        {#snippet right()}
          <Preview
            bind:this={previewRef}
            content={markdown}
            onscroll={handlePreviewScroll}
          />
        {/snippet}
      </SplitPane>
    {:else if viewMode === 'editor'}
      <div class="pane-full" data-pane="editor">
        <Editor
          bind:this={editorRef}
          content={markdown}
          readonly={isReadOnly}
          onchange={handleContentChange}
        />
      </div>
    {:else}
      <div class="pane-full" data-pane="preview">
        <Preview
          bind:this={previewRef}
          content={markdown}
        />
      </div>
    {/if}
  </main>

  <!-- Toast notification -->
  {#if toastMessage}
    <div class="toast toast-{toastType}" role="alert">
      <span class="toast-text">{toastMessage}</span>
      {#if toastAction}
        <button class="toast-action" onclick={toastAction.handler}>
          {toastAction.label}
        </button>
      {/if}
      <button class="toast-dismiss" onclick={dismissToast} aria-label="Dismiss">&times;</button>
    </div>
  {/if}
</div>

<style>
  .app-shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
    position: relative;
  }

  .workspace {
    display: flex;
    flex: 1;
    overflow: hidden;
    min-height: 0;
  }

  .pane-full {
    flex: 1;
    overflow: hidden;
    min-height: 0;
  }

  /* ── Toast ── */

  .toast {
    position: fixed;
    bottom: var(--space-lg, 24px);
    left: 50%;
    transform: translateX(-50%);
    background: var(--ink, #1a1a1a);
    color: var(--paper, #fff);
    padding: var(--space-sm, 8px) var(--space-base, 16px);
    border-radius: var(--radius-md, 6px);
    font-size: var(--text-sm, 0.875rem);
    font-family: var(--font-sans, system-ui, sans-serif);
    display: flex;
    align-items: center;
    gap: var(--space-sm, 8px);
    z-index: var(--z-toast, 500);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    animation: toast-in 200ms ease-out;
    max-width: calc(100vw - 2 * var(--space-lg, 24px));
  }

  .toast-success {
    background: var(--mark-success, #3d7a4e);
    color: #fff;
  }

  .toast-error {
    background: var(--mark-error, #c4483e);
    color: #fff;
  }

  .toast-text {
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .toast-action {
    background: none;
    border: 1px solid rgba(255, 255, 255, 0.4);
    border-radius: var(--radius-sm, 3px);
    color: inherit;
    font-family: inherit;
    font-size: var(--text-sm, 0.875rem);
    font-weight: var(--weight-semibold, 600);
    padding: 2px var(--space-sm, 8px);
    cursor: pointer;
    white-space: nowrap;
    transition: background-color var(--duration-fast, 100ms) ease-out;
  }

  .toast-action:hover {
    background: rgba(255, 255, 255, 0.15);
  }

  .toast-dismiss {
    background: none;
    border: none;
    color: inherit;
    font-size: 1.25rem;
    cursor: pointer;
    padding: 0 2px;
    opacity: 0.7;
    line-height: 1;
  }

  .toast-dismiss:hover {
    opacity: 1;
  }

  @keyframes toast-in {
    from {
      opacity: 0;
      transform: translateX(-50%) translateY(8px);
    }
    to {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
  }
</style>

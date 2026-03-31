/**
 * Keyboard shortcut handling.
 *
 * Registers global keydown listeners for app-wide shortcuts.
 * Provides setup/teardown functions for Svelte component lifecycle.
 *
 * All shortcuts use Cmd (Mac) or Ctrl (Windows/Linux) as the modifier.
 */

import type { ViewMode } from './types';

export interface ShortcutHandlers {
  /** Cmd/Ctrl+S — force save (placeholder: prevents browser save dialog) */
  onSave: () => void;
  /** Cmd/Ctrl+Shift+C — copy rendered content (placeholder: console log) */
  onCopyRendered: () => void;
  /** Cmd/Ctrl+\ — cycle view mode */
  onCycleViewMode: () => void;
  /** Esc — dismiss toasts / close menus */
  onDismiss: () => void;
}

/**
 * Set up global keyboard shortcuts. Returns a cleanup function
 * for use in Svelte's onMount return or onDestroy.
 */
export function setupShortcuts(handlers: ShortcutHandlers): () => void {
  function handleKeydown(e: KeyboardEvent): void {
    const mod = e.metaKey || e.ctrlKey;

    // Cmd/Ctrl+S — save
    if (mod && !e.shiftKey && e.key === 's') {
      e.preventDefault();
      handlers.onSave();
      return;
    }

    // Cmd/Ctrl+Shift+C — copy rendered
    if (mod && e.shiftKey && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      handlers.onCopyRendered();
      return;
    }

    // Cmd/Ctrl+\ — cycle view mode
    if (mod && !e.shiftKey && e.key === '\\') {
      e.preventDefault();
      handlers.onCycleViewMode();
      return;
    }

    // Esc — dismiss
    if (e.key === 'Escape') {
      handlers.onDismiss();
      return;
    }
  }

  window.addEventListener('keydown', handleKeydown);

  return () => {
    window.removeEventListener('keydown', handleKeydown);
  };
}

/** Cycle through view modes: editor → split → preview → editor */
export function cycleViewMode(current: ViewMode): ViewMode {
  const modes: ViewMode[] = ['editor', 'split', 'preview'];
  const idx = modes.indexOf(current);
  return modes[(idx + 1) % modes.length];
}

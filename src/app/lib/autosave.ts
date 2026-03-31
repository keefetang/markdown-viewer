/**
 * Debounced auto-save with state machine.
 *
 * States: idle → saving → saved | error
 * The `readonly` SaveState is set externally (on 403) and stops all future saves.
 *
 * On 429 (rate limited): sets state to `error`, retries after 5 seconds.
 * On 403 (forbidden): sets state to `readonly`, halts all future saves.
 *
 * Concurrency: a boolean `saving` flag prevents overlapping requests.
 * If content changes during an in-flight save, a follow-up save is
 * triggered automatically once the current one completes.
 */

import { saveSession, ApiError } from './api';
import type { CreateResponse } from './api';
import { getTurnstileToken, isTurnstileConfigured } from './turnstile';
import type { SaveState } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AutosaveOptions {
  /** Debounce delay in ms. Defaults to 2000. */
  debounceMs?: number;
  /** Called whenever the save state changes. */
  onStateChange: (state: SaveState) => void;
  /** Called after the first successful save (session creation). */
  onSessionCreated: (id: string, token: string) => void;
}

export interface AutosaveHandle {
  /** Queue a debounced save. No-op if in readonly state. */
  save: (id: string, content: string, editToken: string | null) => void;
  /** Flush: save immediately, bypassing debounce (e.g. Cmd+S). */
  flush: () => Promise<void>;
  /** Tear down timers. */
  destroy: () => void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createAutosave(options: AutosaveOptions): AutosaveHandle {
  const debounceMs = options.debounceMs ?? 2000;

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let halted = false;   // true after 403 — no further saves
  let lastSavedContent: string | null = null;

  // Pending save params (set by `save`, consumed by `doSave`)
  let pendingId: string | null = null;
  let pendingContent: string | null = null;
  let pendingToken: string | null = null;

  // Concurrency guard — prevents overlapping save requests.
  // Set synchronously before the first `await`, cleared in `finally`.
  let saving = false;
  let dirty = false; // true if content changed while a save was in-flight

  function setState(state: SaveState): void {
    if (state === 'readonly') halted = true;
    options.onStateChange(state);
  }

  async function doSave(): Promise<void> {
    if (halted) return;
    if (pendingId === null || pendingContent === null) return;

    // Concurrency guard: if a save is already in-flight, mark dirty and bail.
    // The in-flight save will trigger a follow-up on completion.
    if (saving) {
      dirty = true;
      return;
    }

    // Skip if content hasn't changed since last successful save
    if (pendingContent === lastSavedContent) return;

    const id = pendingId;
    const content = pendingContent;
    const token = pendingToken;

    saving = true;
    dirty = false;
    setState('saving');

    try {
      // On first save (creation — no edit token), include Turnstile token if available
      let turnstileToken: string | null | undefined;
      if (!token && isTurnstileConfigured()) {
        turnstileToken = await getTurnstileToken();
      }

      const result = await saveSession(id, content, token ?? undefined, turnstileToken);

      // Creation response includes editToken — update pending token so
      // subsequent saves use it instead of creating again.
      if ('editToken' in result) {
        const createResult = result as CreateResponse;
        pendingToken = createResult.editToken;
        options.onSessionCreated(id, createResult.editToken);
      }

      lastSavedContent = content;
      setState('saved');
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 403) {
          setState('readonly');
          return;
        }
        if (err.status === 429) {
          setState('error');
          // Auto-retry after 5 seconds (hardcoded — ApiError doesn't carry headers)
          clearTimeout(retryTimer);
          retryTimer = setTimeout(() => {
            void doSave();
          }, 5_000);
          return;
        }
      }
      setState('error');
    } finally {
      saving = false;

      // If content changed while we were saving, trigger a follow-up
      if (dirty && !halted) {
        dirty = false;
        void doSave();
      }
    }
  }

  function save(id: string, content: string, editToken: string | null): void {
    if (halted) return;

    pendingId = id;
    pendingContent = content;
    pendingToken = editToken;

    // Reset debounce timer
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      void doSave();
    }, debounceMs);
  }

  async function flush(): Promise<void> {
    if (halted) return;
    clearTimeout(debounceTimer);
    await doSave();
  }

  function destroy(): void {
    clearTimeout(debounceTimer);
    clearTimeout(retryTimer);
  }

  return { save, flush, destroy };
}

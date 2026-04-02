/** View mode for the editor/preview layout. */
export type ViewMode = 'editor' | 'split' | 'preview';

/** Save state indicator. */
export type SaveState = 'idle' | 'saving' | 'saved' | 'error' | 'readonly';

/** Theme preference: follow system, or force light/dark. */
export type ThemeMode = 'system' | 'light' | 'dark';

/** Content size relative to the server limit. */
export type SizeWarning = 'ok' | 'warning' | 'critical';

/** Maximum content size in bytes (512 KB). Co-located with SizeWarning. */
export const MAX_CONTENT_SIZE = 524_288;

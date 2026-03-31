/** View mode for the editor/preview layout. */
export type ViewMode = 'editor' | 'split' | 'preview';

/** Save state indicator. */
export type SaveState = 'idle' | 'saving' | 'saved' | 'error' | 'readonly';

/** Theme preference: follow system, or force light/dark. */
export type ThemeMode = 'system' | 'light' | 'dark';

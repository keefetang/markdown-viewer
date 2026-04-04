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

// ---------------------------------------------------------------------------
// API Response Types
// ---------------------------------------------------------------------------

/** GET /api/sessions/:id response shape. */
export interface SessionResponse {
  id: string;
  /** Document content. Omitted when `fields=frontmatter` is requested. */
  content?: string;
  metadata: {
    createdAt: number;
    updatedAt: number;
  };
  private: boolean;
  /** Parsed YAML frontmatter, or null if absent/malformed. */
  frontmatter: Record<string, unknown> | null;
  /** Total number of lines in the full document (always present). */
  totalLines: number;
  /** Present only when `offset` or `limit` query params are used. */
  range?: {
    /** 1-indexed start line of the returned content. */
    offset: number;
    /** Number of lines requested (may exceed available lines). */
    limit?: number;
  };
  etag: string;
  /** SHA-256 hex digest of the document content (64 chars). */
  contentHash: string;
  /** Expiry timestamp (epoch ms). Omitted when TTL is unknown. */
  expiresAt?: number;
}

/** A single changelog entry from the edit history API. */
export interface HistoryEntry {
  /** Timestamp (epoch ms) of the change. */
  ts: number;
  /** Agent-provided description of the change. */
  summary: string;
  /** Content size in bytes after the write. */
  bytes: number;
}

/** Response shape for GET /api/sessions/:id/history. */
export interface HistoryResponse {
  id: string;
  history: HistoryEntry[];
}

/** Response shape for GET /api/sessions/:id/backlinks. */
export interface BacklinksResponse {
  id: string;
  backlinks: string[];
}

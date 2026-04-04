/**
 * MCP Server — 13 tools for AI agent access to the markdown-viewer platform.
 *
 * Uses `createMcpHandler()` from the Agents SDK for stateless MCP serving.
 * No Durable Objects, no wrangler config changes — tools are pure KV
 * operations via the shared session logic.
 *
 * A new McpServer is created per request (SDK requirement — servers can't
 * be reused across connections).
 */

import { createMcpHandler } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { normalizeETag, sliceContent } from './shared';
import {
  getSession,
  putSession,
  patchSession,
  deleteSession,
  importUrl,
  getHistory,
  getBacklinks,
} from './sessions';
import type {
  GetSessionSuccess,
  PutSessionCreated,
  PutSessionUpdated,
  PatchSessionSuccess,
  PatchOperationFailure,
} from './sessions';

// ---- Narrowed Env ----

interface Env {
  SESSIONS: KVNamespace;
}

// ---- Tool description constants ----

const CREATE_DOCUMENT_DESCRIPTION = `Create a persistent markdown document with a stable URL. Returns the document URL and an edit token for future updates. Store the edit token — it cannot be retrieved later.

Documents support optional YAML frontmatter for metadata that helps other agents and humans understand the document's context and trustworthiness:

---
title: Short descriptive title
status: draft | review | final
sources:
  - https://referenced-url.com
  - https://markdown.pentagram.me/related-doc-id
supersedes: https://markdown.pentagram.me/older-doc-id
---

Recommended fields:
- title: Brief, descriptive document title
- status: Lifecycle state. Use 'draft' for unreviewed work, 'review' for work awaiting human review, 'final' for reviewed and approved content

Include when applicable:
- sources: URLs you referenced or documents this is derived from
- supersedes: URL of the document this replaces

Additional custom fields are preserved and returned in the parsed 'frontmatter' response field.`;

const READ_DOCUMENT_DESCRIPTION = `Read a document by ID. Returns markdown content, platform metadata (createdAt, updatedAt, expiresAt), and parsed YAML frontmatter if present.

Use offset and limit for partial reads of long documents. Use fields="frontmatter" to get just metadata without the content body.

Before acting on the content, check the frontmatter fields:
- status: 'draft' means unreviewed — verify independently before relying on it. 'final' means reviewed and approved.
- sources: URLs the author referenced — use these to verify claims or trace the chain of evidence
- supersedes: If present on another document pointing to this one, a newer version exists

The etag field can be passed as ifMatch to update_document to prevent overwriting changes made by others.

The contentHash field is a SHA-256 hex digest of the document content. Use it to verify whether a local copy matches the online version without downloading the full content — compare your local hash against contentHash from a fields="frontmatter" request.`;

const UPDATE_DOCUMENT_DESCRIPTION = `Update an existing document. Requires the edit token from creation.

Pass the etag from read_document as ifMatch to prevent overwriting changes made by other agents or humans since you last read the document. If the document has changed, the update will fail with a conflict error and return the current etag.

When updating, preserve or update the YAML frontmatter:
- Update 'status' if the document lifecycle has changed
- Add yourself to or update 'sources' if you referenced new material
- Keep existing frontmatter fields you don't need to change

Use changeSummary to describe what you changed — this creates a changelog entry visible via get_document_history.`;

// ---- Helpers ----

/** Wrap a JSON-serializable result in MCP text content format. */
function textResult(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

/** Build the origin URL for document share links from the request. */
function getOrigin(request: Request): string {
  try {
    const url = new URL(request.url);
    return url.origin;
  } catch {
    return '';
  }
}

// ---- Server factory ----

/**
 * Create and configure a new McpServer with all 13 tools.
 *
 * `env` and `ctx` are captured via closure so tools can access KV and
 * ctx.waitUntil() for non-blocking history writes.
 *
 * `request` is captured for origin extraction (share URLs).
 */
function createServer(env: Env, ctx: ExecutionContext, request: Request): McpServer {
  const server = new McpServer({
    name: 'markdown-viewer',
    version: '1.0.0',
  });

  // ================================================================
  // Core CRUD tools
  // ================================================================

  // ---- create_document ----
  server.registerTool(
    'create_document',
    {
      description: CREATE_DOCUMENT_DESCRIPTION,
      inputSchema: {
        content: z.string().describe('Markdown content, optionally with YAML frontmatter'),
        private: z.boolean().optional().describe('If true, document requires edit token to read. Default: false'),
        id: z.string().regex(/^[A-Za-z0-9_-]{12}$/).optional().describe('Custom 12-char URL-safe ID. Auto-generated if omitted'),
      },
    },
    async ({ content, private: isPrivate, id: customId }) => {
      const { nanoid } = await import('nanoid');
      const id = customId ?? nanoid(12);

      const result = await putSession(env, ctx, id, content, {
        private: isPrivate,
        ifNoneMatchStar: true, // Reject if ID already exists (clear error instead of "Forbidden")
        requestOrigin: getOrigin(request),
        origin: getOrigin(request),
      });

      if (!result.success) {
        return textResult({ error: result.error });
      }

      if (result.created) {
        const created = result as PutSessionCreated;
        return textResult({
          id: created.id,
          url: created.url,
          editUrl: created.editUrl,
          editToken: created.editToken,
          metadata: created.metadata,
          private: created.private,
          frontmatter: created.frontmatter,
          etag: created.etag,
          contentHash: created.contentHash,
          expiresAt: created.expiresAt,
        });
      }

      // Should not reach here for create, but handle gracefully
      const updated = result as PutSessionUpdated;
      return textResult({
        id: updated.id,
        metadata: updated.metadata,
        private: updated.private,
        frontmatter: updated.frontmatter,
        etag: updated.etag,
        contentHash: updated.contentHash,
        expiresAt: updated.expiresAt,
      });
    },
  );

  // ---- read_document ----
  server.registerTool(
    'read_document',
    {
      description: READ_DOCUMENT_DESCRIPTION,
      inputSchema: {
        id: z.string().describe('Document ID (12-char URL-safe string)'),
        editToken: z.string().optional().describe('Required for private documents'),
        offset: z.number().int().min(1).optional().describe('Start line (1-indexed) for partial read'),
        limit: z.number().int().min(1).optional().describe('Number of lines to return'),
        fields: z.enum(['frontmatter']).optional().describe('"frontmatter" for metadata-only read (no content)'),
      },
    },
    async ({ id, editToken, offset, limit, fields }) => {
      const result = await getSession(env, id, editToken);

      if (!result.success) {
        return textResult({ error: result.error });
      }

      if ('notModified' in result) {
        return textResult({ unchanged: true });
      }

      const session = result as GetSessionSuccess;

      // Fields filter — frontmatter only
      if (fields === 'frontmatter') {
        return textResult({
          id: session.id,
          metadata: session.metadata,
          private: session.private,
          frontmatter: session.frontmatter,
          totalLines: session.totalLines,
          etag: session.etag,
          contentHash: session.contentHash,
          expiresAt: session.expiresAt,
        });
      }

      // Line-range slicing
      const { sliced: content, totalLines } = sliceContent(session.content, offset, limit);

      return textResult({
        id: session.id,
        content,
        metadata: session.metadata,
        private: session.private,
        frontmatter: session.frontmatter,
        totalLines: session.totalLines,
        etag: session.etag,
        contentHash: session.contentHash,
        expiresAt: session.expiresAt,
      });
    },
  );

  // ---- update_document ----
  server.registerTool(
    'update_document',
    {
      description: UPDATE_DOCUMENT_DESCRIPTION,
      inputSchema: {
        id: z.string().describe('Document ID'),
        editToken: z.string().describe('Edit token from creation'),
        content: z.string().describe('New markdown content'),
        private: z.boolean().optional().describe('Update privacy setting'),
        ifMatch: z.string().optional().describe('ETag for conditional update (prevents clobbering)'),
        changeSummary: z.string().optional().describe('Describe the change for the changelog'),
      },
    },
    async ({ id, editToken, content, private: isPrivate, ifMatch, changeSummary }) => {
      const result = await putSession(env, ctx, id, content, {
        editToken,
        private: isPrivate,
        ifMatch,
        changeSummary,
        requestOrigin: getOrigin(request),
        origin: getOrigin(request),
      });

      if (!result.success) {
        const error: Record<string, unknown> = { error: result.error };
        if (result.currentETag) error.currentETag = result.currentETag;
        return textResult(error);
      }

      // Never expose editToken on update
      if (result.created) {
        const created = result as PutSessionCreated;
        return textResult({
          id: created.id,
          metadata: created.metadata,
          private: created.private,
          frontmatter: created.frontmatter,
          etag: created.etag,
          contentHash: created.contentHash,
          expiresAt: created.expiresAt,
        });
      }

      const updated = result as PutSessionUpdated;
      return textResult({
        id: updated.id,
        metadata: updated.metadata,
        private: updated.private,
        frontmatter: updated.frontmatter,
        etag: updated.etag,
        contentHash: updated.contentHash,
        expiresAt: updated.expiresAt,
      });
    },
  );

  // ---- delete_document ----
  server.registerTool(
    'delete_document',
    {
      description: 'Delete a document permanently. Requires the edit token from creation.',
      inputSchema: {
        id: z.string().describe('Document ID'),
        editToken: z.string().describe('Edit token from creation'),
      },
    },
    async ({ id, editToken }) => {
      const result = await deleteSession(env, ctx, id, editToken);

      if (!result.success) {
        return textResult({ error: result.error });
      }

      return textResult({ success: true });
    },
  );

  // ---- import_url ----
  server.registerTool(
    'import_url',
    {
      description: 'Fetch markdown content from a URL. HTTPS only, text content types only (no HTML), 512KB limit.',
      inputSchema: {
        url: z.string().url().describe('HTTPS URL to fetch'),
      },
    },
    async ({ url }) => {
      const result = await importUrl(url);

      if (!result.success) {
        return textResult({ error: result.error });
      }

      return textResult({ content: result.content });
    },
  );

  // ================================================================
  // Partial write tools
  // ================================================================

  // ---- append_to_document ----
  server.registerTool(
    'append_to_document',
    {
      description: 'Add content to the end of a document without replacing existing content. Zero conflict risk — purely additive.',
      inputSchema: {
        id: z.string().describe('Document ID'),
        editToken: z.string().describe('Edit token from creation'),
        content: z.string().describe('Content to append'),
        changeSummary: z.string().optional().describe('Describe the addition for the changelog'),
      },
    },
    async ({ id, editToken, content, changeSummary }) => {
      const result = await patchSession(env, ctx, id, [{ op: 'append', content }], editToken, { changeSummary, origin: getOrigin(request) });
      return formatPatchResult(result);
    },
  );

  // ---- insert_after_line ----
  server.registerTool(
    'insert_after_line',
    {
      description: 'Find a line by partial or full string match, insert content starting from the next line. Fails if zero or multiple lines match — provide more specific text to disambiguate. Existing content is never modified.',
      inputSchema: {
        id: z.string().describe('Document ID'),
        editToken: z.string().describe('Edit token from creation'),
        match: z.string().describe('Text to search for within each line'),
        content: z.string().describe('Content to insert after the matched line'),
        ifMatch: z.string().optional().describe('ETag for conditional update'),
        changeSummary: z.string().optional().describe('Describe the change for the changelog'),
      },
    },
    async ({ id, editToken, match, content, ifMatch, changeSummary }) => {
      const result = await patchSession(
        env, ctx, id,
        [{ op: 'insertAfter', match, content }],
        editToken,
        { ifMatch, changeSummary, origin: getOrigin(request) },
      );
      return formatPatchResult(result);
    },
  );

  // ---- replace_line ----
  server.registerTool(
    'replace_line',
    {
      description: 'Find a line by partial or full string match, replace it with new content. Same match rules as insert_after_line — fails on zero or multiple matches. Use empty content to delete the matched line.',
      inputSchema: {
        id: z.string().describe('Document ID'),
        editToken: z.string().describe('Edit token from creation'),
        match: z.string().describe('Text to search for within each line'),
        content: z.string().describe('Replacement content (can be multiple lines or empty to delete)'),
        ifMatch: z.string().optional().describe('ETag for conditional update'),
        changeSummary: z.string().optional().describe('Describe the change for the changelog'),
      },
    },
    async ({ id, editToken, match, content, ifMatch, changeSummary }) => {
      const result = await patchSession(
        env, ctx, id,
        [{ op: 'replaceLine', match, content }],
        editToken,
        { ifMatch, changeSummary, origin: getOrigin(request) },
      );
      return formatPatchResult(result);
    },
  );

  // ---- update_frontmatter ----
  server.registerTool(
    'update_frontmatter',
    {
      description: 'Update YAML frontmatter fields without touching the document body. Merges fields into existing frontmatter. Set a field to null to remove it. If the document has no frontmatter, creates one.',
      inputSchema: {
        id: z.string().describe('Document ID'),
        editToken: z.string().describe('Edit token from creation'),
        fields: z.record(z.string(), z.unknown()).describe('Fields to merge into frontmatter. Set a field to null to remove it.'),
        ifMatch: z.string().optional().describe('ETag for conditional update'),
        changeSummary: z.string().optional().describe('Describe the change for the changelog'),
      },
    },
    async ({ id, editToken, fields, ifMatch, changeSummary }) => {
      const result = await patchSession(
        env, ctx, id,
        [{ op: 'updateFrontmatter', fields }],
        editToken,
        { ifMatch, changeSummary, origin: getOrigin(request) },
      );
      return formatPatchResult(result);
    },
  );

  // ================================================================
  // Batch tools
  // ================================================================

  // ---- batch_read_documents ----
  server.registerTool(
    'batch_read_documents',
    {
      description: 'Read multiple documents in one call. More efficient than reading individually — saves tool calls and tokens. Supports conditional reads via ETags to skip unchanged documents.',
      inputSchema: {
        ids: z.array(z.string()).min(1).max(20).describe('Document IDs, max 20'),
        tokens: z.record(z.string(), z.string()).optional().describe('Edit tokens for private docs, keyed by document ID'),
        etags: z.record(z.string(), z.string()).optional().describe('ETags from previous reads, keyed by document ID'),
        fields: z.enum(['frontmatter']).optional().describe('"frontmatter" for metadata-only reads'),
        offset: z.number().int().min(1).optional().describe('Start line for partial read'),
        limit: z.number().int().min(1).optional().describe('Number of lines to return'),
      },
    },
    async ({ ids, tokens, etags: _etags, fields, offset, limit }) => {
      // Cast optional record types — Zod v4 infers Record values as {}
      const tokenMap = tokens as Record<string, string> | undefined;
      const etagMap = _etags as Record<string, string> | undefined;

      const documents: unknown[] = [];
      const errors: unknown[] = [];

      const results = await Promise.allSettled(
        ids.map(async (id) => {
          const editToken = tokenMap?.[id];
          const result = await getSession(env, id, editToken);
          return { id, result };
        }),
      );

      for (const settled of results) {
        if (settled.status === 'rejected') {
          errors.push({ id: 'unknown', status: 500, error: 'Internal error' });
          continue;
        }

        const { id, result } = settled.value;

        if (!result.success) {
          errors.push({ id, status: result.status, error: result.error });
          continue;
        }

        if ('notModified' in result) {
          documents.push({ id, unchanged: true });
          continue;
        }

        const session = result as GetSessionSuccess;

        // Check if client has current version via etags
        if (etagMap?.[id]) {
          const clientEtag = normalizeETag(etagMap[id]);
          const serverEtag = normalizeETag(session.etag);
          if (clientEtag === serverEtag) {
            documents.push({ id, unchanged: true, etag: session.etag });
            continue;
          }
        }

        // Fields filter — frontmatter only
        if (fields === 'frontmatter') {
          documents.push({
            id: session.id,
            metadata: session.metadata,
            private: session.private,
            frontmatter: session.frontmatter,
            totalLines: session.totalLines,
            etag: session.etag,
            contentHash: session.contentHash,
            expiresAt: session.expiresAt,
          });
          continue;
        }

        // Line-range slicing
        const { sliced: content } = sliceContent(session.content, offset, limit);

        documents.push({
          id: session.id,
          content,
          metadata: session.metadata,
          private: session.private,
          frontmatter: session.frontmatter,
          totalLines: session.totalLines,
          etag: session.etag,
          contentHash: session.contentHash,
          expiresAt: session.expiresAt,
        });
      }

      return textResult({ documents, errors });
    },
  );

  // ---- batch_update_documents ----
  server.registerTool(
    'batch_update_documents',
    {
      description: 'Update multiple documents in one call. Each update is independent — some may succeed while others fail.',
      inputSchema: {
        updates: z.array(z.object({
          id: z.string().describe('Document ID'),
          editToken: z.string().describe('Edit token from creation'),
          content: z.string().describe('New markdown content'),
          ifMatch: z.string().optional().describe('ETag for conditional update'),
          changeSummary: z.string().optional().describe('Describe the change'),
          private: z.boolean().optional().describe('Update privacy setting'),
        })).min(1).max(10).describe('Updates to apply, max 10'),
      },
    },
    async ({ updates }) => {
      const results: unknown[] = [];
      const errors: unknown[] = [];

      // Sequential updates to avoid KV rate limit races
      for (const update of updates) {
        const result = await putSession(env, ctx, update.id, update.content, {
          editToken: update.editToken,
          private: update.private,
          ifMatch: update.ifMatch,
          changeSummary: update.changeSummary,
          requestOrigin: getOrigin(request),
          origin: getOrigin(request),
        });

        if (!result.success) {
          const error: Record<string, unknown> = {
            id: update.id,
            status: result.status,
            error: result.error,
          };
          if (result.currentETag) error.currentETag = result.currentETag;
          errors.push(error);
          continue;
        }

        // Never expose editToken in batch results
        if (result.created) {
          const created = result as PutSessionCreated;
          results.push({
            id: created.id,
            metadata: created.metadata,
            private: created.private,
            frontmatter: created.frontmatter,
            etag: created.etag,
            contentHash: created.contentHash,
            expiresAt: created.expiresAt,
          });
        } else {
          const updated = result as PutSessionUpdated;
          results.push({
            id: updated.id,
            metadata: updated.metadata,
            private: updated.private,
            frontmatter: updated.frontmatter,
            etag: updated.etag,
            contentHash: updated.contentHash,
            expiresAt: updated.expiresAt,
          });
        }
      }

      return textResult({ results, errors });
    },
  );

  // ================================================================
  // History tool
  // ================================================================

  // ---- get_document_history ----
  server.registerTool(
    'get_document_history',
    {
      description: 'Get the changelog for a document. Shows timestamped summaries of changes made via the API, newest first.',
      inputSchema: {
        id: z.string().describe('Document ID'),
        editToken: z.string().optional().describe('Required for private documents'),
      },
    },
    async ({ id, editToken }) => {
      const result = await getHistory(env, id, editToken);

      if (!result.success) {
        return textResult({ error: result.error });
      }

      return textResult({
        id: result.id,
        history: result.history,
      });
    },
  );

  // ================================================================
  // Backlinks tool
  // ================================================================

  // ---- get_backlinks ----
  server.registerTool(
    'get_backlinks',
    {
      description: 'Get documents that link to this document. Returns IDs of documents whose content or frontmatter references this document via sources, supersedes, or inline links.',
      inputSchema: {
        id: z.string().describe('Document ID (12-char URL-safe string)'),
        editToken: z.string().optional().describe('Required for private documents'),
      },
    },
    async ({ id, editToken }) => {
      const result = await getBacklinks(env, id, editToken);

      if (!result.success) {
        return textResult({ error: result.error });
      }

      return textResult({
        id: result.id,
        backlinks: result.backlinks,
      });
    },
  );

  return server;
}

// ---- Shared patch result formatter ----

function formatPatchResult(result: import('./sessions').PatchSessionResult) {
  if (!result.success) {
    if ('failedOperation' in result) {
      const failure = result as PatchOperationFailure;
      return textResult({
        error: failure.error,
        failedOperation: failure.failedOperation,
        op: failure.op,
      });
    }
    const error: Record<string, unknown> = { error: result.error };
    if (result.currentETag) error.currentETag = result.currentETag;
    return textResult(error);
  }

  const patch = result as PatchSessionSuccess;
  return textResult({
    id: patch.id,
    metadata: patch.metadata,
    private: patch.private,
    frontmatter: patch.frontmatter,
    etag: patch.etag,
    contentHash: patch.contentHash,
    expiresAt: patch.expiresAt,
  });
}

// ---- Exported handler factory ----

/**
 * Create the MCP request handler for the `/mcp` route.
 *
 * Returns a function compatible with the Worker fetch handler signature.
 * The caller in index.ts passes through requests that match the `/mcp` path.
 */
export function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const server = createServer(env, ctx, request);
  const handler = createMcpHandler(server, { route: '/mcp' });
  return handler(request, env, ctx);
}

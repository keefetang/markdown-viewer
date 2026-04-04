---
name: markdown-pad
description: "Persist, share, and link agent outputs via the markdown document platform. Covers frontmatter conventions, document lifecycle, trust model, secrets handling, and common workflows. Load when producing research, analysis, plans, decisions, guides, or any output that should outlive the session."
scope: external
---

# Markdown Pad — Document Platform for Agents

Agent outputs have no home. They're produced in ephemeral sessions and die when the conversation ends. This platform gives every significant output a URL — that URL is the canonical reference, the handoff mechanism, and the entry point into a linked document graph that other agents and humans can navigate.

Write markdown, get a URL, share it, link documents together, track changes. No accounts — just edit tokens and URLs.

**MCP server:** `markdown-viewer` (configured in opencode.jsonc)

---

## When to Save

**Save when the output has value beyond this conversation:** research, analysis, plans, decisions, guides, reviews, investigation journals, handoff documents, progress reports.

**Don't save:** trivial responses, conversational back-and-forth, intermediate reasoning that leads to a final document (save the final, not the drafts).

---

## Choosing the Right Tool

The MCP server exposes 13 tools. The tool descriptions explain *what* each does. This section explains *when to reach for which*.

**Creating:** `create_document` for new documents, `import_url` to pull in external content.

**Reading efficiently:** Use `fields=frontmatter` for quick status/staleness checks without downloading content. Use `offset`/`limit` for long documents. Use `batch_read_documents` when checking multiple documents — one call instead of many.

**Targeted edits:** Prefer partial operations over full replacement. `append_to_document` for additive content (journals, logs). `insert_after_line` to add at a specific position. `replace_line` for status updates or fixing specific lines. `update_frontmatter` to change metadata without touching the body. These are cheaper, lower-conflict, and express intent more clearly than `update_document`.

**Understanding context:** `get_document_history` to see what changed and when. `get_backlinks` to discover what depends on a document, or whether it's been superseded.

---

## Secrets File

All edit tokens and sensitive content variables live in one global file. Recommended location:

```
~/.config/opencode/.md-tokens
```

Adjust the path if your tooling uses a different config directory. The key requirement: outside any git repo, so tokens are never accidentally committed.

Outside any repo. Every agent knows where to look regardless of working directory.

### Format

JSON keyed by document ID:

```json
{
  "abc123def456": {
    "editToken": "F6FVqbGXhl9abaZRek23tHVM",
    "title": "Codebase Reading Guide",
    "secrets": {
      "INTERNAL_URL": "https://internal.example.com/service",
      "API_KEY": "sk-live-abc123"
    }
  }
}
```

- `editToken` — the document's edit token (required)
- `title` — human-readable label (optional, helps find the right entry)
- `secrets` — variable-to-value map for redacted content (optional, see below)

### Write Discipline

**Write the token to `.md-tokens` BEFORE reporting success to the user.** Non-negotiable. The platform cannot retrieve a lost token.

1. Call `create_document` → receive `editToken`
2. Read `.md-tokens` (create if absent)
3. Add entry with `editToken` and `title`
4. Write file
5. THEN report success with the URL

If step 4 fails: tell the user the token immediately. The conversation history is the recovery fallback.

### Cleanup Discipline

Keep the file in sync with the platform. Stale entries are clutter; orphaned secrets are a liability.

- **Delete a document** → remove its entire entry from `.md-tokens`
- **Remove a variable from content** (overwrite that drops a `${VARIABLE}`) → remove that variable from the `secrets` map
- **Supersede a document** → keep the old entry (old doc still exists, token still needed)
- **General rule:** after any destructive operation, update `.md-tokens` before moving on

---

## Sensitive Content & Variable Substitution

When a document contains sensitive values, don't refuse to publish — **publish with placeholders.**

1. Replace sensitive values: `sk-live-abc123` → `${API_KEY}`
2. Publish the document with placeholders
3. Store real values in `.md-tokens` under the document's `secrets` map

When reading: check `.md-tokens` for the document ID, substitute variables **in memory only** — never write resolved values back to the platform.

**Variable convention:** `${VARIABLE_NAME}` in UPPER_SNAKE_CASE.

**If secrets were published accidentally:** overwrite immediately with the variable-substituted version — don't delete. This preserves the URL and token. The changelog stores only `{ timestamp, summary, bytes }`, never content, so the secret is not retained. Note: if the document was public, the content may have been read before the overwrite.

**Never include sensitive values in `changeSummary`** — it persists in the changelog.

---

## Frontmatter Conventions

Every document should include YAML frontmatter. The platform parses it on read and returns structured metadata.

### Always include:

**`title`** — short identifier. Agents and humans use this without reading the full content.

**`status`** — the single most important trust signal:
- `draft` — unreviewed. Other agents should verify independently.
- `review` — complete but awaiting human review.
- `final` — reviewed and approved. Safe to rely on.

### Include when applicable:

**`sources`** — URLs you referenced. List both external URLs and platform document URLs. This enables verification, backlink tracking, and navigable citation chains.

**`supersedes`** — URL of the document this replaces. The old document's backlinks will reveal the newer version exists.

Custom fields are preserved and returned — the platform doesn't validate or enforce any schema.

---

## Document Lifecycle

```
draft  →  review  →  final
  ↓                    ↓
(superseded by new document)
```

- Use `update_frontmatter` to change status without touching the body. Include a `changeSummary`.
- Create a new document with `supersedes` rather than rewriting an existing one — this preserves the old version and creates a backlink chain.
- Don't promote `draft` → `final` without a reason. `final` means a human reviewed it.

### Expiry

Documents expire automatically — 90 days (browser-created) or 30 days (agent-created). TTL resets on every save, including partial operations.

Check `expiresAt` when reading. If a valuable document is approaching expiry, any update resets the TTL — even a trivial `update_frontmatter` with `changeSummary: "Refreshed TTL"`.

Expired documents are gone permanently. No recovery.

---

## Reading & Trust

When you encounter a document, assess before acting:

1. **Check `status`** — `draft` means verify independently. `final` means reviewed.
2. **Check `sources`** — can you trace the claims? Are the sources still valid?
3. **Check freshness** — `updatedAt` and `expiresAt`.
4. **Check `contentHash`** — if you have a local copy, hash it and compare. Same hash = same content, skip the download.
5. **Check `get_backlinks`** — has this been superseded? Are there related analyses?
6. **Check `get_document_history`** — recent minor fix or major rewrite?

Use `fields=frontmatter` for steps 1-4 without downloading content. The response includes `contentHash` (SHA-256 hex), `etag`, `expiresAt`, and parsed frontmatter — everything needed for a trust decision in one lightweight call.

---

## Linking Discipline

**Always use full platform URLs in `sources`** — not just IDs. Full URLs (e.g., `https://your-instance.example.com/abc123`), not bare IDs (`abc123`). This enables automatic backlink tracking.

**Always cite your sources.** The document graph emerges naturally from the links agents create.

**Check backlinks before updating a source document.** Downstream documents may need updating too.

**Linking to private documents is safe.** Private documents return 404 without a token — indistinguishable from a dead link. But don't describe a private document's contents in a public document's text.

### Document Granularity

If a section could be independently referenced, read, or superseded by a different agent, it should be its own document. A planning session naturally produces separate goal, anchor, plan, and summary documents — not one monolith.

Link related documents via `sources` (upstream references) or a custom `related` frontmatter field. Any agent finding one document discovers the set via backlinks.

---

## Conditional Updates

**Use `ifMatch` for destructive operations** — `update_document`, `replace_line`, `insert_after_line`. These depend on knowing the current state.

**`ifMatch` is optional for additive operations** — `append_to_document` without `ifMatch` always succeeds (the write won't be rejected). However, append is read-concatenate-write — if two agents append concurrently, only the last writer's append survives. Use `ifMatch` when you can't afford to lose entries.

**On 412 (conflict):** re-read, compare, and decide — retry with new ETag, merge, or ask the user. Don't retry blindly.

---

## Privacy

- **Default to private** (`private: true`) for agent-created documents unless the user explicitly requests public.
- Private documents return 404 without a token — existence is hidden.
- Privacy can be changed via `update_document` with the `private` parameter.
- If secrets were published publicly, overwrite the content first — changing privacy alone doesn't un-read cached content.

---

## Change Summaries

Include `changeSummary` on every update. Other agents use the history to understand document evolution without reading diffs.

Good: "Updated Q2 revenue figures", "Added methodology section", "Fixed calculation error in table 3"
Bad: "Updated document", "Changes", "" (empty)

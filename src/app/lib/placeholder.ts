/**
 * Default placeholder markdown shown on new sessions.
 *
 * This serves as both onboarding content and a live demo of supported
 * markdown features — every markup used here is proven to render correctly.
 */

export const PLACEHOLDER_MARKDOWN = `# Welcome to Markdown Viewer

A fast, privacy-first markdown pad. Write on the left, see rendered prose on the right. Share via URL.

## Text Formatting

**Bold**, *italic*, ~~strikethrough~~, ***bold italic***, and \`inline code\`.

## Code Blocks

\`\`\`javascript
function greet(name) {
  const hour = new Date().getHours();
  return \`\${hour < 12 ? 'Good morning' : 'Hello'}, \${name}!\`;
}
\`\`\`

\`\`\`python
def fibonacci(n: int) -> list[int]:
    a, b = 0, 1
    return [(a, (a, b) := (b, a + b))[0] for _ in range(n)]
\`\`\`

## Tables

| Feature          | Notes                          |
| ---------------- | ------------------------------ |
| Live preview     | Updates as you type            |
| Sync scrolling   | Editor and preview scroll together |
| Syntax highlight | JS, Python, Go, Rust + more    |
| Math (KaTeX)     | \`$E=mc^2$\` — lazy-loaded     |
| Dark mode        | System, light, or dark         |
| Auto-save        | Debounced, with edit tokens    |
| Share            | Edit link or read-only link    |
| Import           | From file or URL               |
| Export           | Markdown, HTML, or PDF         |

## Task List

- [x] Editor with CodeMirror 6
- [x] Live preview with GFM
- [x] Auto-save and sharing
- [x] Import from file and URL
- [x] Export to Markdown, HTML, PDF

## Blockquote

> The split pane is the *transformation boundary* — raw markdown becomes rendered prose.

## Supported Syntax

This viewer supports [GitHub Flavored Markdown](https://github.github.com/gfm/) including tables, task lists, strikethrough, and fenced code blocks. Math rendering uses [KaTeX](https://katex.org/) (\`$inline$\` and \`$$block$$\`), loaded on demand.

---

*Start typing to replace this content. Your work auto-saves.*
`;

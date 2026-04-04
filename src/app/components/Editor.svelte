<script lang="ts">
  /**
   * CodeMirror 6 editor wrapper.
   *
   * Thin integration layer: mount CM6, relay content changes, expose scroll sync.
   * The parent owns the markdown state; this component is a controlled input.
   */
  import { onMount } from 'svelte';
  import { EditorState, Compartment } from '@codemirror/state';
  import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightSpecialChars, drawSelection, rectangularSelection } from '@codemirror/view';
  import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
  import { bracketMatching, indentOnInput, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
  import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
  import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
  import { tags } from '@lezer/highlight';
  import { HighlightStyle } from '@codemirror/language';

  // ─── Props (Svelte 5 runes) ──────────────────────────────────────────────

  interface Props {
    content?: string;
    readonly?: boolean;
    lineWrap?: boolean;
    onchange?: (content: string) => void;
    onscroll?: (line: number) => void;
  }

  let {
    content = $bindable(''),
    readonly = false,
    lineWrap = true,
    onchange,
    onscroll,
  }: Props = $props();

  // ─── Internal state ──────────────────────────────────────────────────────

  let containerEl: HTMLDivElement;
  let view: EditorView | undefined;
  // Compartments allow reconfiguring extensions without recreating the entire
  // EditorState — CM6's immutable state model requires this pattern for any
  // extension that changes after initialization.
  const readOnlyCompartment = new Compartment();
  const wrapCompartment = new Compartment();

  /**
   * Tracks the last content string that was synced between the prop and CM6.
   * Used to break feedback loops statelessly — both the update listener and
   * the content-sync $effect compare against this to avoid re-emitting/re-dispatching.
   */
  let lastSyncedContent = '';

  // ─── CodeMirror theme — design system tokens ─────────────────────────────

  const editorTheme = EditorView.theme({
    '&': {
      backgroundColor: 'var(--paper-inset)',
      color: 'var(--ink)',
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-sm)',
    },
    '.cm-content': {
      caretColor: 'var(--margin-note)',
      fontFamily: 'var(--font-mono)',
      lineHeight: 'var(--leading-relaxed)',
      padding: 'var(--space-md) 0',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: 'var(--margin-note)',
      borderLeftWidth: '2px',
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
      /* Uses color-mix to derive from --margin-note, adapts to light/dark */
      backgroundColor: 'color-mix(in srgb, var(--margin-note) 20%, transparent)',
    },
    '.cm-activeLine': {
      backgroundColor: 'var(--pencil-subtle)',
    },
    '.cm-gutters': {
      backgroundColor: 'var(--paper-inset)',
      color: 'var(--ink-muted)',
      border: 'none',
      borderRight: '1px solid var(--pencil-subtle)',
    },
    '.cm-lineNumbers .cm-gutterElement': {
      padding: '0 var(--space-sm) 0 var(--space-xs)',
      minWidth: '3ch',
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-sm)',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'var(--pencil-subtle)',
      color: 'var(--ink-secondary)',
    },
    '&.cm-focused': {
      outline: 'none',
    },
    '.cm-matchingBracket': {
      backgroundColor: 'var(--pencil-strong)',
      color: 'var(--ink)',
      outline: 'none',
    },
    '.cm-selectionMatch': {
      backgroundColor: 'color-mix(in srgb, var(--margin-note) 12%, transparent)',
    },
    '.cm-foldPlaceholder': {
      backgroundColor: 'var(--paper-inset)',
      border: '1px solid var(--pencil)',
      color: 'var(--ink-muted)',
    },
  });

  /** Syntax highlighting using design system palette */
  const syntaxTheme = HighlightStyle.define([
    { tag: tags.heading, fontWeight: 'var(--weight-semibold)', color: 'var(--ink)' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.strong, fontWeight: 'var(--weight-semibold)' },
    { tag: tags.link, color: 'var(--margin-note)', textDecoration: 'underline' },
    { tag: tags.url, color: 'var(--margin-note)' },
    { tag: tags.monospace, color: 'var(--code-text)', fontFamily: 'var(--font-mono)' },
    { tag: tags.strikethrough, textDecoration: 'line-through' },
    { tag: tags.quote, color: 'var(--ink-secondary)', fontStyle: 'italic' },
    { tag: tags.meta, color: 'var(--ink-muted)' },
    { tag: tags.comment, color: 'var(--ink-muted)', fontStyle: 'italic' },
    { tag: tags.processingInstruction, color: 'var(--ink-muted)' },
  ]);

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  onMount(() => {
    lastSyncedContent = content;

    const startState = EditorState.create({
      doc: content,
      extensions: [
        // Core editing
        history(),
        drawSelection(),
        rectangularSelection(),
        highlightSpecialChars(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        indentOnInput(),
        bracketMatching(),
        lineNumbers(),

        // Language
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        syntaxHighlighting(syntaxTheme),

        // Keybindings
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
          indentWithTab,
        ]),

        // Read-only (reconfigurable via compartment)
        readOnlyCompartment.of(EditorState.readOnly.of(readonly)),

        // Line wrapping (reconfigurable via compartment)
        wrapCompartment.of(lineWrap ? EditorView.lineWrapping : []),

        // Theme
        editorTheme,

        // Accessible name for the contenteditable textbox (WCAG aria-input-field-name)
        EditorView.contentAttributes.of({ 'aria-label': 'Markdown editor' }),

        // Content change listener — stateless loop prevention via lastSyncedContent
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const newContent = update.state.doc.toString();
            if (newContent !== lastSyncedContent) {
              lastSyncedContent = newContent;
              content = newContent;
              onchange?.(newContent);
            }
          }
        }),
      ],
    });

    view = new EditorView({
      state: startState,
      parent: containerEl,
    });

    // Scroll listener for sync scrolling — reports the 0-indexed source line
    // at the top of the visible viewport, with sub-line fractional precision.
    const scroller = view.scrollDOM;
    const handleScroll = () => {
      if (!onscroll || !view) return;
      onscroll(getTopVisibleLine());
    };
    scroller.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      scroller.removeEventListener('scroll', handleScroll);
      view?.destroy();
      view = undefined;
    };
  });

  // ─── React to prop changes ────────────────────────────────────────────────

  // ReadOnly toggle via compartment reconfigure
  $effect(() => {
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(readonly)),
    });
  });

  // Line wrap toggle via compartment reconfigure
  $effect(() => {
    if (!view) return;
    view.dispatch({
      effects: wrapCompartment.reconfigure(lineWrap ? EditorView.lineWrapping : []),
    });
  });

  // Content changes from outside (e.g., loading a session).
  // Only dispatch when the prop value differs from what we last synced —
  // this prevents the $effect from re-dispatching on every keystroke.
  $effect(() => {
    if (!view) return;
    if (content !== lastSyncedContent) {
      lastSyncedContent = content;
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: content,
        },
      });
    }
  });

  // ─── Scroll helpers ───────────────────────────────────────────────────────

  /**
   * Get the 0-indexed source line at the top of the CodeMirror viewport.
   * Returns a fractional value for sub-line precision.
   */
  function getTopVisibleLine(): number {
    if (!view) return 0;

    const scrollTop = view.scrollDOM.scrollTop;
    const block = view.lineBlockAtHeight(scrollTop);
    const topLine = view.state.doc.lineAt(block.from);

    // Fractional: how far through this visual line block are we?
    const fraction = block.bottom > block.top
      ? (scrollTop - block.top) / (block.bottom - block.top)
      : 0;

    // Convert to 0-indexed to match data-line attributes
    return topLine.number - 1 + Math.max(0, Math.min(1, fraction));
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /** Scroll the editor to a source line (0-indexed, fractional). */
  export function scrollToSourceLine(line: number): void {
    if (!view) return;
    const doc = view.state.doc;
    const lineNum = Math.floor(line) + 1; // Convert 0-indexed to 1-indexed
    if (lineNum < 1 || lineNum > doc.lines) return;

    const pos = doc.line(lineNum).from;
    const block = view.lineBlockAt(pos);

    // Fractional offset within the line
    const fraction = line - Math.floor(line);
    const targetTop = block.top + fraction * (block.bottom - block.top);

    view.scrollDOM.scrollTop = targetTop;
  }

  /** Get the target scroll position for a 1-indexed line number. */
  export function getLineScrollTop(line: number): number | null {
    if (!view) return null;
    const doc = view.state.doc;
    if (line < 1 || line > doc.lines) return null;
    const pos = doc.line(line).from;
    return view.lineBlockAt(pos).top;
  }

  /** Get the scroll DOM element for external animation control. */
  export function getScrollDOM(): HTMLElement | null {
    return view?.scrollDOM ?? null;
  }
</script>

<div class="editor-container" bind:this={containerEl} data-pane="editor"></div>

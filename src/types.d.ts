// Type declarations for untyped third-party modules

// Svelte component imports
declare module '*.svelte' {
  import type { Component } from 'svelte';
  const component: Component;
  export default component;
}

declare module 'markdown-it-task-lists' {
  import type MarkdownIt from 'markdown-it';

  interface TaskListsOptions {
    /** Make checkboxes interactive (default: false) */
    enabled?: boolean;
    /** Wrap checkbox + text in a <label> (default: false) */
    label?: boolean;
    /** Place label after checkbox (default: false) */
    labelAfter?: boolean;
  }

  function taskLists(md: MarkdownIt, options?: TaskListsOptions): void;
  export default taskLists;
}

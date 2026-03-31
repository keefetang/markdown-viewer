import './styles/global.css';
import { mount } from 'svelte';
import App from './App.svelte';

// Apply stored theme preference before mount to minimize flash of wrong theme.
// Runs before Svelte mounts — the module executes early enough for small SPAs.
// Key must match THEME_KEY in App.svelte.
try {
  const storedTheme = localStorage.getItem('markdown-viewer-theme');
  if (storedTheme === 'dark' || storedTheme === 'light') {
    document.documentElement.setAttribute('data-theme', storedTheme);
  }
} catch {
  // localStorage unavailable — follow system preference
}

const target = document.getElementById('app');
if (!target) throw new Error('Missing #app element');

mount(App, { target });

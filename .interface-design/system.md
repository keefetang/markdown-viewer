# Markdown Viewer — Design System

## Direction & Feel

**Intent:** A writing surface. The person is alone with their thoughts — composing, editing, thinking in markdown. Morning light on paper, the quiet focus of drafting.

**Feel:** Warm, minimal, content-focused. iA Writer meets HackMD. Not an IDE (no dark-default, no panel-heavy chrome). Not playful (no rounded-everything, no bright accents). Present when needed, invisible when not.

**Signature:** The transformation boundary — the split-pane divider where raw markdown becomes rendered prose. Everything in the design reinforces this duality: monospace on the left (raw, honest, code-like), proportional on the right (polished, typographic, finished). The divider is the moment of transformation.

## Domain Exploration

**World:** Paper, ink, drafts, margins, pencil annotations, the writer's desk. Warm materials, focused light, the physicality of writing even in a digital space.

**Color world:**
- Paper whites and creams (the surface you write on)
- Ink blacks — warm, not pure (fountain pen, not printer toner)
- Pencil grays (annotations, structure, the scaffolding of thought)
- Margin blue-gray (the teacher's annotation color, now digital — links, interactive elements)
- Red pencil (errors, deletions — the editor's mark)
- Green check (saved, confirmed — the proofreader's approval)

**Defaults rejected:**
- Dark IDE themes as default → Light paper-white default, dark as alternative
- Heavy toolbars with icon grids → Minimal text-forward toolbar, breathing room
- Card-based layouts → Full-bleed writing surface, no cards containing content
- Bootstrap/utility-class aesthetics → Product-specific tokens named for the domain

## Depth Strategy

**Borders-only.** This is a writing tool — flat like paper. No shadows lifting surfaces. Borders define regions with rgba transparency so they blend naturally with any surface beneath them.

Rationale: Shadows suggest dimensional objects. A writing surface should feel like paper — flat, honest, the content IS the depth. Structure comes from quiet borders and whitespace, not elevation.

## Color Palette

### Light Theme

| Token | Value | Role |
|-------|-------|------|
| `--paper` | `#faf8f5` | Canvas — warm off-white, not blue-cool |
| `--paper-above` | `#ffffff` | Elevated surfaces (toolbar, panels) |
| `--paper-inset` | `#f3f0eb` | Recessed surfaces (editor, inputs) |
| `--paper-overlay` | `#ffffff` | Modals, dialogs |
| `--ink` | `#2c2824` | Primary text — warm near-black |
| `--ink-secondary` | `#5c5650` | Supporting text |
| `--ink-muted` | `#706b66` | Metadata, timestamps (≥ 4.5:1 on paper-inset) |
| `--ink-faint` | `#b8b2ac` | Disabled, placeholder |
| `--margin-note` | `#3d6d8e` | Accent — links, interactive elements (WCAG AA on paper) |
| `--mark-error` | `#c4483e` | Red pencil — errors |
| `--mark-warning` | `#9a7226` | Amber — unsaved, caution (WCAG AA on paper) |
| `--mark-success` | `#3d7a4e` | Green — saved, valid (WCAG AA on paper) |
| `--code-surface` | `#efebe5` | Code block backgrounds |
| `--code-text` | `#5c4a3a` | Code text — warm brown |

### Dark Theme

Warm charcoal — NOT pure black, NOT blue-cold. Higher surfaces are slightly lighter (dark mode elevation principle). Text is warm cream, not pure white.

| Token | Value | Role |
|-------|-------|------|
| `--paper` | `#1c1a18` | Canvas — deep warm charcoal |
| `--paper-above` | `#252320` | Elevated (+1 step) |
| `--paper-inset` | `#141210` | Recessed (darker) |
| `--paper-overlay` | `#2a2826` | Modals, dialogs |
| `--ink` | `#e8e4df` | Primary text — warm cream |
| `--ink-secondary` | `#b5b0a9` | Supporting text |
| `--ink-muted` | `#908a84` | Metadata, timestamps (≥ 4.5:1 on paper-inset) |
| `--ink-faint` | `#524e4a` | Disabled, placeholder |
| `--ink-inverse` | `#1c1a18` | Text on light backgrounds |
| `--margin-note` | `#6ba3c7` | Accent — brighter for dark bg |
| `--margin-hover` | `#82b5d6` | Hover state |
| `--margin-active` | `#5690b4` | Active/pressed state |
| `--mark-error` | `#d4706a` | Slightly desaturated red |
| `--mark-warning` | `#cca050` | Slightly desaturated amber |
| `--mark-success` | `#6aab7e` | Slightly desaturated green |
| `--code-surface` | `#232018` | Code block backgrounds |
| `--code-text` | `#c8b8a8` | Code text |

Borders in dark mode use `rgba(232, 228, 223, ...)` — white-based with the same opacity scale as light mode.

## Typography

**Sans stack** (UI chrome): `-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, 'Helvetica Neue', Helvetica, Arial, sans-serif`

**Mono stack** (editor): `ui-monospace, 'SF Mono', 'Cascadia Code', 'Segoe UI Mono', Menlo, Consolas, 'Liberation Mono', monospace`

### Size Scale

| Token | Size | Use |
|-------|------|-----|
| `--text-xs` | 11px | Badges, fine print |
| `--text-sm` | 13px | Labels, metadata |
| `--text-base` | 15px | Body text |
| `--text-md` | 17px | Emphasized body |
| `--text-lg` | 20px | Section headings |
| `--text-xl` | 24px | Page headings |
| `--text-2xl` | 30px | Display |

### Weights
- `--weight-normal`: 400 — body text
- `--weight-medium`: 500 — labels, UI controls
- `--weight-semibold`: 600 — headings, emphasis
- `--weight-bold`: 700 — strong emphasis (rare)

### Line Heights
- `--leading-tight`: 1.25 — headings
- `--leading-snug`: 1.4 — compact UI
- `--leading-normal`: 1.6 — body/reading
- `--leading-relaxed`: 1.75 — editor lines

## Spacing

**Base unit: 4px.** Writing tools need granularity for fine-tuning padding within controls.

| Token | Value | Use |
|-------|-------|-----|
| `--space-xs` | 4px | Icon gaps, tight pairs |
| `--space-sm` | 8px | Within components |
| `--space-md` | 12px | Component padding |
| `--space-base` | 16px | Standard spacing |
| `--space-lg` | 24px | Between groups |
| `--space-xl` | 32px | Section separation |
| `--space-2xl` | 48px | Major landmarks |
| `--space-3xl` | 64px | Page-level spacing |

## Border Radius

Slightly rounded — precise, not playful.

| Token | Value | Use |
|-------|-------|-----|
| `--radius-sm` | 3px | Inputs, small controls |
| `--radius-md` | 5px | Buttons, cards |
| `--radius-lg` | 8px | Panels, modals |
| `--radius-full` | 9999px | Pills, toggles |

## Transitions

| Token | Value | Use |
|-------|-------|-----|
| `--duration-fast` | 100ms | Hover, focus |
| `--duration-normal` | 180ms | State changes |
| `--duration-slow` | 300ms | Panels, modals |
| `--ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | Deceleration |
| `--ease-in-out` | `cubic-bezier(0.65, 0, 0.35, 1)` | Symmetric |

## Z-Index Scale

| Token | Value | Use |
|-------|-------|-----|
| `--z-base` | 0 | Default |
| `--z-above` | 10 | Sticky elements |
| `--z-toolbar` | 100 | Toolbar |
| `--z-dropdown` | 200 | Dropdowns, popovers |
| `--z-overlay` | 300 | Backdrop overlays |
| `--z-modal` | 400 | Modals, dialogs |
| `--z-toast` | 500 | Toast notifications |

## Component Patterns

_To be added as components are built. Save patterns when a component is used 2+ times or has specific measurements worth preserving._

## Key Decisions Log

1. **Warm palette, not cool.** The writing world is paper and ink — warm materials. Blue-gray-cool would feel like an IDE.
2. **15px base font size.** Slightly larger than typical 14px because this is a reading/writing tool — readability is paramount.
3. **Borders-only depth.** Flat like paper. Shadows would contradict the "writing surface" metaphor.
4. **4px spacing base.** Writing tools need granularity (toolbar icon spacing, editor padding) that 8px base can't provide without half-steps.
5. **System font stacks.** Speed-first. No FOUT, no layout shift, no external requests. The content is the star, not the typeface.
6. **Token naming from the domain.** `--ink`, `--paper`, `--pencil`, `--margin-note` — someone reading only the tokens can guess this is a writing tool.

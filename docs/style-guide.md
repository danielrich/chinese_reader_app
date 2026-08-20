# Chinese Reader Style Guide

## Theme Defaults

The app's primary theme is light. CSS defaults should render correctly in light
mode without requiring `@media (prefers-color-scheme: light)` fixes.

Use semantic CSS tokens for new UI instead of raw theme colors:

```css
background: var(--surface-panel);
border-color: var(--border-subtle);
color: var(--text-secondary);
```

Current core tokens live in `src/style.css` under `:root`:

- `--surface-page`: page background.
- `--surface-panel`: section/panel background.
- `--surface-card`: repeated item/card background.
- `--surface-muted`: subdued controls or secondary rows.
- `--border-subtle`: panel/card borders.
- `--border-control`: form control borders.
- `--text-primary`: primary body text.
- `--text-secondary`: secondary metadata text.
- `--text-muted`: quiet headings, labels, and empty-state text.
- `--accent`: primary action and active-tab accent.

Dark mode values are defined once in `@media (prefers-color-scheme: dark)`.
New components should normally not need their own light-mode override if they
use these tokens.

## Layout Conventions

- Use full-width sections with constrained inner content for major app areas.
- Use cards for repeated items, modals, and framed tools only.
- Keep card/panel radii at `8px` or less.
- Use compact headings inside dashboards and tool surfaces.
- Keep controls and stats stable in size so dynamic labels do not shift layout.

## Regression Check

When adding a new view or panel, check it in the app's normal light theme before
shipping. If a component needs dark support, add or reuse semantic tokens rather
than hardcoding paired dark/light colors.

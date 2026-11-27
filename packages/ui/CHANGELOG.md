# @repo/ui

## 0.4.0

### Minor Changes

- 9ff6629: `ErrorState` takes `codeVariant="bracketed"`, which sets `code` between the `[·]` mark's two brackets — `[ 404 ]` — in Space Grotesk 600 at a display rung (`text-display-sm` full page, `text-display-xs` in a panel). The code stays its own text node; the brackets are hidden from assistive technology. The default, `"mono"`, is the existing small mono line.
- d1ba621: `ListToolbarSkeleton` draws the row's `extra` controls: `extra` takes one named size per control (`"control"` for a `size="sm"` button, `"icon"` for `FunnelFilter`'s 40px square trigger), or a single size. `dateRange` now also takes a count, so a row with a quick range and a date range draws two placeholders. Existing props and defaults are unchanged.

## 0.3.0

### Minor Changes

- c714998: Filter usability pass (#7737). `FacetFilter`'s trigger names its selection (`Status: Failed, Running`, or `Status · 3` past two) with a raised box and a sibling × that clears that facet only; its popover is 240px with 32px rows and grows a search box past eight options (`searchable` overrides, `formatValue` labels a value). `FilterSearch` clears on Esc, exposes its input through `inputRef`, and draws a key hint plus `aria-keyshortcuts` when given a `shortcut`; `ListToolbar` passes both through `search` (the `/` key itself is answered by the console's shortcut registry, not by this package). `FilterBarReset` is tracked at 0.14em. New `FilterEmpty` (`@repo/ui/filter-bar`): "No <noun> match these filters." with Clear filters, built on `EmptyState`.

## 0.2.0

### Minor Changes

- c903fb6: Remove list counts: `PageToolbar`, `PageToolbarSkeleton` and `SectionHeading` no longer take a `count` prop, and `CountPill` is removed from `count-pill` (use `CountFigure` for a figure that is content).
- ee3d8cb: Add the `[·]` mark loader: `MarkLoader` from `@repo/brand/loader` (inline, region and page sizes, CSS-only motion in `tokens.css` with a reduced-motion rule), a `pending` prop on `Button`, and `Spinner` now draws the mark.
- 379329f: Add `ListToolbar` and `ListToolbarSkeleton` (`@repo/ui/list-toolbar`), and promote `ErrorState` (`@repo/ui/error-state`, now with a `mark` slot) and `RegionError` (`@repo/ui/region-error`) from the console.

## 0.1.1

### Patch Changes

- 08f55f5: Describe each package on npm instead of the placeholder "Alethia <name>".

## 0.1.0

### Minor Changes

- eaeb9a3: First public release on npm as `@alethialabs/*`.

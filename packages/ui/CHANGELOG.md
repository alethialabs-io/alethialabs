# @repo/ui

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

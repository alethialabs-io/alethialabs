---
"@repo/ui": minor
---

`ListToolbarSkeleton` draws the row's `extra` controls: `extra` takes one named size per control (`"control"` for a `size="sm"` button, `"icon"` for `FunnelFilter`'s 40px square trigger), or a single size. `dateRange` now also takes a count, so a row with a quick range and a date range draws two placeholders. Existing props and defaults are unchanged.

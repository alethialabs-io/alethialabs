---
"@repo/ui": minor
---

Filter usability pass (#7737). `FacetFilter`'s trigger names its selection (`Status: Failed, Running`, or `Status · 3` past two) with a raised box and a sibling × that clears that facet only; its popover is 240px with 32px rows and grows a search box past eight options (`searchable` overrides, `formatValue` labels a value). `FilterSearch` clears on Esc, exposes its input through `inputRef`, and draws a key hint plus `aria-keyshortcuts` when given a `shortcut`; `ListToolbar` passes both through `search` (the `/` key itself is answered by the console's shortcut registry, not by this package). `FilterBarReset` is tracked at 0.14em. New `FilterEmpty` (`@repo/ui/filter-bar`): "No <noun> match these filters." with Clear filters, built on `EmptyState`.

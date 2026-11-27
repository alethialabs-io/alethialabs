---
"@repo/ui": patch
---

The toast `loading` icon and the multi-combobox fetching row draw the inline `[·]` mark (`MarkGlyph` from `./spinner`) instead of a spinning lucide `Loader2` (#7871). The toast mark is decorative beside the toast's own text; the combobox row is one `role="status"` reading "Loading options…".

// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Density tuning for `@repo/ui/empty`'s `EmptyState` inside the Artifacts library.
 *
 * The shared component ships `border-dashed` with no border WIDTH, so a caller opts in with
 * `border`; the 420px column is the only other local thing. Everything else — the padding and
 * the `text-lg` headline — stays the shared default, because the library IS a page-sized region.
 *
 * It lives in its own module for the reason `panel-empty.ts` does: the gallery imports the
 * viewer, so exporting it from `agent-artifact-gallery.tsx` would make the import cycle. One
 * string, two readers, and the panel's loading, empty and no-widgets states cannot drift into
 * three densities — which they had, the loading line rendering at the shared page scale while
 * the state it flashes before rendered at this one.
 */
export const GALLERY_EMPTY = "mx-auto max-w-[420px] border border-border";

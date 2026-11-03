// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The case view's frames, as class lists the view and its loading form BOTH render (#6354, B2): a
// skeleton that copied them by hand is how the thread drifted. No "use client" and no React, so the
// route's `loading.tsx` (a server component) can import them without pulling the thread's
// markdown stack into its chunk.

/** The attachments panel. */
export const CASE_ATTACHMENTS = "space-y-2 rounded-md border p-4";

/** The attachments panel's heading row (a paperclip and "Attachments", `text-xs`). */
export const CASE_ATTACHMENTS_HEADING = "flex items-center gap-2 text-xs font-medium text-muted-foreground";

/** The attachments list; each row is one `text-sm` line. */
export const CASE_ATTACHMENTS_LIST = "space-y-1";

/** The bordered frame the conversation sits in. */
export const CASE_THREAD = "rounded-md border";

/**
 * The thread's scroll viewport: bounded, so a long thread scrolls inside the case rather than
 * pushing the composer below the fold (a smaller cap on a phone keeps it reachable) — without a
 * bound the viewport is as tall as its content and there is nothing to stick to the bottom of.
 * `overscroll-auto` because the thread sits in a scrolling page: a swipe at its edge carries on to
 * the page.
 */
export const CASE_THREAD_VIEWPORT = "max-h-[60dvh] overscroll-auto scrollbar-thin sm:max-h-[70dvh]";

/** The padding inside the thread's message column (the column's own gap is the scroller's). */
export const CASE_THREAD_CONTENT = "p-4";

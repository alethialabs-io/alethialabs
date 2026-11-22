// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The page's name below 768px.
//
// The console has no page titles: the sidebar row and the breadcrumb name the page. Below `lg`
// the sidebar is a closed drawer, and below `md` the breadcrumb used to be hidden as well, so on a
// phone nothing on screen said which page it was. The topbar cannot take the crumb at that width:
// at 400px its row already holds the menu button, the two switchers and three actions.
//
// So below `md` the SAME breadcrumb element leaves the topbar's middle track and becomes a strip
// directly under the header, showing only its last crumb, the current page. It is one element at
// every width, not a second copy: a duplicate would put two `navigation` landmarks named
// "breadcrumb" in the document.
//
// The strip takes height from `<main>`, and three surfaces size themselves as "one viewport less
// the shell header" by reading `--shell-header-h` (`SHELL_VIEWPORT`, `./shell-metrics.ts`). So the
// main column re-states that variable for everything inside `<main>` as header + strip, below `md`
// only, and those surfaces stay exactly one screen tall. It is done with two variables on two
// elements because a custom property cannot be defined in terms of itself: the column records the
// header's height under a second name, and `<main>`, one level down, adds the strip to that.
//
// These are in their own module, not in `shell-metrics.ts`, because pages import that file and
// only the shell needs these.

/** On the shell root: the strip's height. */
export const CRUMB_STRIP_VARS = "[--shell-crumb-h:2rem]";

/** On the main column: the topbar's height under a name `<main>` can still read after it re-states `--shell-header-h`. */
export const MAIN_COLUMN_VARS = "[--shell-topbar-h:var(--shell-header-h)]";

/**
 * On `<main>`, below `md`: start under the strip, and tell everything inside that the shell's
 * chrome is the header plus the strip.
 */
export const MAIN_UNDER_CRUMB_STRIP =
	"max-md:mt-(--shell-crumb-h) max-md:[--shell-header-h:calc(var(--shell-topbar-h)+var(--shell-crumb-h))]";

/**
 * On the breadcrumb's box in the topbar. From `md` up it is an in-flow item of the header's middle
 * track. Below `md` it is the strip: positioned under the header's bottom border, as wide as the
 * main column, with every crumb but the last one hidden. The header is its containing block.
 */
export const CRUMB_BOX =
	"flex min-w-0 items-center empty:hidden max-md:absolute max-md:inset-x-0 max-md:top-[calc(100%+1px)] max-md:h-(--shell-crumb-h) max-md:border-b max-md:bg-background max-md:px-4 max-md:[&_li:not(:last-child)]:hidden";

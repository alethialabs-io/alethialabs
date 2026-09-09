// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The shell's HEIGHT metrics, deliberately in their own module rather than beside `CONTENT_FRAME`.
 *
 * `scripts/check-route-states.mjs` resolves a page's declared content width from the page file AND
 * every module it directly imports, one level deep, by reading string literals out of them. So a
 * module that exports a width poisons every importer: a page importing `SHELL_VIEWPORT` from
 * `content-frame` was scored as declaring `max-w-[1200px]` on top of its shell's, which is an S4
 * failure — two widths on one route — for a page that declares no width at all.
 *
 * That is not a defect in the guard. Reading one level of imports is what lets it see a width a
 * page pulls in from a helper, which is the case it exists for. The fix is on this side: keep the
 * heights where a page can import them without also importing a width.
 */

/**
 * The shell's ONE header height, as a class — the topbar, both sidebar heads and the Elench panel
 * header all read it, so their bottom borders draw one continuous line.
 *
 * The number lives in `app/globals.css` as `--shell-header-h` (53px). Before this existed it was
 * typed as `h-[53px]` in four files and as `3.5rem` (56px) in three others, and the Elench panel
 * header did not set a height at all — its content came out at ≈54.5px, so its seam sat 1.5px
 * below the topbar's. A constant read from one variable is what makes "aligned" a property of the
 * shell rather than of each file's arithmetic.
 */
export const SHELL_HEADER = "h-(--shell-header-h)";

/** One viewport less the shell header — for a surface that fills the main column exactly. */
export const SHELL_VIEWPORT = "h-[calc(100dvh-var(--shell-header-h))]";

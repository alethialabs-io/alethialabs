// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The ONE "the shell has rendered" wait, shared by every flow spec.
//
// `navigation-shell.spec.ts` used to carry its own: `getByRole("link", { name: "Overview" })`.
// The shell painted TWO of those — the sidebar row and the breadcrumb's current page, which the
// breadcrumb primitive rendered with `role="link"` — so Playwright's strict mode refused it, and
// most of that file's tests failed on the helper before reaching anything they were written to
// measure (apps/console/docs/qa/findings.md §5). `cross-cutting.spec.ts` had already scoped the
// same locator to the complementary landmark and passed. Two files disagreeing about one wait is
// the shape this module exists to end: one definition, imported by both.
//
// THE SECOND "Overview" IS GONE AS OF #4267 — `packages/ui/src/breadcrumb.tsx`'s current page is a
// `<span aria-current="page">` now, with no role at all, because it is not a link and never was.
// THE SCOPE STAYS ANYWAY, and not out of habit: below `lg` the sidebar is re-mounted inside the
// slide-in Sheet, so a drawer opened over a route that still has its own "Overview" is a second
// match this helper must never resolve to; and an unscoped wait would go green on a page that
// painted a nav row without the landmark that makes it navigation. What changed is that the scope
// is now a statement about WHICH navigation, not a workaround for a defect in another component.

import { expect, type Page } from "@playwright/test";

/**
 * Resolves once the org sidebar has rendered its Overview row, scoped to the `complementary`
 * landmark so the breadcrumb's current-page control can never make the locator ambiguous.
 */
export async function waitForShell(page: Page, timeout = 20_000): Promise<void> {
	await expect(page.getByRole("complementary").getByRole("link", { name: "Overview", exact: true })).toBeVisible({
		timeout,
	});
}

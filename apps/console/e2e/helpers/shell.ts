// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The ONE "the shell has rendered" wait, shared by every flow spec.
//
// `navigation-shell.spec.ts` used to carry its own: `getByRole("link", { name: "Overview" })`.
// The shell paints TWO of those — the sidebar row and the breadcrumb's current page, which the
// breadcrumb primitive renders with `role="link"` — so Playwright's strict mode refused it, and 29
// of that file's 31 tests failed on the helper before reaching anything they were written to
// measure (apps/console/docs/qa/findings.md §5). `cross-cutting.spec.ts` had already scoped the
// same locator to the complementary landmark and passed. Two files disagreeing about one wait is
// the shape this module exists to end: one definition, imported by both.

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

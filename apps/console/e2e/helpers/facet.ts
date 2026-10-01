// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { Locator, Page } from "@playwright/test";

/**
 * The filter bar's facet trigger for `name` — and ONLY that trigger.
 *
 * A facet and a sortable table column usually share a word ("Status"), and since #5056 the sortable
 * `<th>` carries a real `<button>` named by its column: the WAI-ARIA sortable-header pattern. So a
 * page-wide `getByRole("button", { name: /^Status/ })` resolves to both and trips strict mode. What
 * separates them is structural, not textual: the facet (`@repo/ui/facet-filter`) is a popover
 * trigger, which Base UI marks `aria-haspopup="dialog"`; the sort toggle opens nothing. Matching on
 * that keeps the locator exact without leaning on DOM position or on the table being absent.
 */
export function facetTrigger(page: Page, name: string | RegExp): Locator {
	return page.getByRole("button", { name }).and(page.locator('[aria-haspopup="dialog"]'));
}

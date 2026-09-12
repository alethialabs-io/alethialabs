// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// E2E: the Settings → Activity feed for a BRAND-NEW org. Asserts the page-level wiring on a fresh
// authed org: the reusable filter bar renders, CSV export is gated on a fresh (Hobby) plan, and
// selecting a server-side filter drives a refetch — narrowing to denials, which an org created
// seconds ago has none of, lands on the empty state.
//
// The FILTER STANDARD itself — that all seven `ActivityFilters` keys (search, actorIds,
// projectIds, eventTokens, from, to, rangeLabel) round-trip through the URL in both directions —
// is `e2e/flows/agent-usage-activity.spec.ts`'s, because it needs seeded members and projects to
// select. What this file owns is the fresh-org half: a filter bar with nothing behind it still
// filters, and still says so.
//
// Note: the bold actor/target rendering and the "Load more" trigger need seeded rows, so they
// are covered by the unit tests (tests/components/activity-feed.test.tsx) rather than here.
//
// Run locally with `pnpm dev:up` + `pnpm -C apps/console run test:e2e`.

import { expect, test } from "./fixtures/auth";

test.describe("Activity page (a brand-new org)", () => {
	test("renders the filter bar and gates export on a fresh plan", async ({
		authedPage: page,
		orgSlug,
	}) => {
		await page.goto(`/${orgSlug}/~/settings/activity`);

		// The reusable filter bar the user liked.
		await expect(page.getByPlaceholder(/search actor, action or resource/i)).toBeVisible();
		await expect(page.getByRole("button", { name: /^events$/i })).toBeVisible();

		// CSV export is Enterprise-only; a fresh Hobby org sees it disabled.
		await expect(page.getByRole("button", { name: /export csv/i })).toBeDisabled();
	});

	test("narrowing to denials drives a server refetch to the empty state", async ({
		authedPage: page,
		orgSlug,
	}) => {
		await page.goto(`/${orgSlug}/~/settings/activity`);
		await expect(page.getByPlaceholder(/search actor, action or resource/i)).toBeVisible();

		// Open the event-type sheet and keep only denials — a fresh org has none.
		await page.getByRole("button", { name: /^events$/i }).click();
		const sheet = page.getByRole("dialog");

		// EXPAND "Result" FIRST. `GroupedFilterSheet`'s groups open with `useState(count > 0)`
		// (packages/ui/src/grouped-filter-sheet.tsx), so on a pristine filter every group is shut
		// and its options are inside a `CollapsibleContent` that is not rendered at all. The old
		// test clicked "Denied" straight after opening the sheet and had been recorded `failed`
		// for it — red on the test, not on the product.
		await expect(sheet.getByText("Result", { exact: true })).toBeVisible();
		await sheet.getByText("Result", { exact: true }).click();
		await sheet.getByText("Denied", { exact: true }).click();
		await page.keyboard.press("Escape");

		// The token reached the URL (the store's own contract) AND the feed refetched to nothing.
		// Both, because either alone is satisfiable without the other: a filter that never leaves
		// the client still empties an empty feed, and a URL that updates without a refetch is the
		// bug the standard's server half exists to prevent.
		await expect(page).toHaveURL(/[?&]eventTokens=result%3Adeny\b/, { timeout: 15_000 });
		await expect(page.getByText(/no activity matches these filters/i)).toBeVisible({
			timeout: 30_000,
		});
	});
});

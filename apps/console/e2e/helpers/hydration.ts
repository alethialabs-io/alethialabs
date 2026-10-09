// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, type Page } from "@playwright/test";

/**
 * Resolve once a filter bar that carries `@repo/ui/date-range-filter` has HYDRATED, so the next
 * click lands on a live control rather than on server HTML that nothing is listening to.
 *
 * VISIBLE IS NOT INTERACTIVE (#5786). A streamed page paints its server HTML before React has
 * hydrated it, and `load` does not wait for hydration either. Playwright's actionability checks —
 * visible, enabled, stable — all pass on that inert markup, so a click in the window goes to a
 * boundary React cannot hydrate on the spot (its client code is still arriving) and is DROPPED:
 * React stops the event rather than replaying it. On the Activity page that window is ~200 ms
 * after `load`, and a test that clicked "Last 7 days" the moment it was visible lost the click on
 * every CI load: the popover never opened (release-gate run 37901209188 — the trace's input
 * snapshot is the server's trigger, the after-click snapshot the hydrated one). It went unseen
 * before #5786 only because the consent provider forced every streamed boundary to be rendered
 * on the client, and client-rendered HTML is live the moment it appears.
 *
 * The signal: the date-range trigger renders the placeholder "Date range" on the server and the
 * formatted window only after mount (`date-range-filter.tsx` gates its label on a mount effect,
 * #418). A mount effect runs after the hydration commit, so once the placeholder is gone every
 * control committed with it — the quick-range trigger beside it included — has its handlers.
 *
 * #5849 measured the window again and found a second cause beside the first: on Activity the
 * "Last 7 days" trigger sits between the `flex-1` search box and the date-range trigger, and the
 * date-range label growing from "Date range" to the formatted window at mount slid it 136 px left,
 * so a click aimed at the painted trigger landed on the bar. The date-range trigger now holds its
 * width from the first paint, and the shell evaluates far less before it can hydrate, so the
 * Activity spec's window test now clicks the moment the trigger is visible. The remaining callers
 * keep this wait; it is still the honest signal for "this bar is live".
 *
 * `anchor` is a control in the same bar that the server already renders; waiting for it first is
 * what keeps "no placeholder" from passing on a page that has not painted the bar at all.
 */
export async function untilFilterBarHydrated(page: Page, anchor: RegExp): Promise<void> {
	await expect(page.getByRole("button", { name: anchor })).toBeVisible({ timeout: 30_000 });
	await expect(page.getByRole("button", { name: "Date range", exact: true })).toHaveCount(0, {
		timeout: 30_000,
	});
}

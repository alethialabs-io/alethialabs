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
 * width from the first paint, and the shell evaluates far less before it can hydrate; the qa
 * fixture also waits for hydration after every `goto` (`untilPageHydrated`, below). What is left
 * of this helper is the bar-specific form of that wait.
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

/**
 * Resolve once every control the page has painted is live — owned by React rather than server HTML
 * nothing is listening to — or after `timeout`, whichever comes first. Never throws: it is a
 * safety net under a spec's own assertions, not an assertion.
 *
 * WHY EVERY GOTO NEEDS THIS (#5849). Since #5786 a full load HYDRATES the server's HTML instead of
 * rendering it again, and React hydrates the page's streamed Suspense boundaries in passes AFTER the
 * shell, at its lowest priority. Measured in CI (release-gate run 37919762246) the page's first
 * filter-bar trigger went live 300–550 ms after the shell did. In that window a Playwright click
 * passes every actionability check on inert markup, and `fill` writes into an input whose
 * `onChange` is not attached yet; a locator can also match a server copy still parked in a hidden
 * `S:` segment beside the one being moved into place.
 *
 * THE SIGNAL. React records the props it owns on each host node under a `__reactProps$<id>` key
 * when it hydrates (or creates) the node. Every visible control in `main` — or `body` on a page
 * with no `main` — carrying that key means the boundary it lives in has hydrated. Two more things
 * keep a half-arrived page from passing: no parked `S:` segment is waiting to be moved in, and no
 * boundary is still marked pending (`<!--$?-->`) by the stream. It reads a React-internal key name,
 * which is stable from React 17 to 19 and which the console's own tests do not otherwise depend on;
 * if a React upgrade renames it, this times out on every page, and that is loud in the perf
 * attachment rather than silent.
 */
export async function untilPageHydrated(page: Page, timeout = 15_000): Promise<void> {
	await page
		.waitForFunction(
			() => {
				const root = document.querySelector("main") ?? document.body;
				if (!root) return false;
				if (document.querySelector('div[hidden][id^="S:"]')) return false;
				const pending = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
				for (let c = pending.nextNode(); c; c = pending.nextNode()) {
					if (c.nodeValue === "$?") return false;
				}
				const controls = root.querySelectorAll(
					'button, input, select, textarea, a[href], [role="button"], [role="tab"], [role="combobox"]',
				);
				for (const el of controls) {
					if (el.closest("[hidden]")) continue;
					if (!Object.keys(el).some((k) => k.startsWith("__reactProps$"))) return false;
				}
				return true;
			},
			undefined,
			{ timeout },
		)
		.catch(() => undefined);
}

/**
 * Make `page.goto` and `page.reload` wait for {@link untilPageHydrated} after the navigation they
 * already wait for. A navigation that asked for `waitUntil: "commit"` is left alone: it wants the
 * page before it is ready.
 */
export function waitForHydrationOnNavigation(page: Page): void {
	const goto = page.goto.bind(page);
	const reload = page.reload.bind(page);
	page.goto = async (url, options) => {
		const response = await goto(url, options);
		if (options?.waitUntil !== "commit") await untilPageHydrated(page);
		return response;
	};
	page.reload = async (options) => {
		const response = await reload(options);
		if (options?.waitUntil !== "commit") await untilPageHydrated(page);
		return response;
	};
}

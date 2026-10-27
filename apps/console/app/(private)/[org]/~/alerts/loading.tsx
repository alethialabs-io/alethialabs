// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the alerts route shows before the server has decided what the page IS (F021, #6125).
 *
 * The page is plan- and permission-gated: an org without alerting gets the upsell, a member without
 * `view_alerts` the no-access notice, everyone else the hub. Which one is a per-org, per-viewer fact
 * this file cannot know — it is the instant fallback Next shows on navigation, before `page.tsx` has
 * resolved the actor — so it promises no shape at all: a busy region and nothing in it. The hub's
 * own skeleton (`AlertsSkeleton`, its real layout) is the `<Suspense>` fallback `page.tsx` renders
 * once the gate has said the hub is coming.
 */
export default function AlertsLoading() {
	return (
		<div role="status" aria-busy="true">
			<span className="sr-only">Loading alerts</span>
		</div>
	);
}

// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { SelfManagedUsageNotice } from "@/components/settings/usage/self-managed-usage-notice";
import { UsageSkeleton } from "@/components/settings/usage/usage-skeleton";
import { isStripeConfigured } from "@/lib/billing/config";

/**
 * Instant loading state for the org usage route, in the shape of the page that replaces it (F008,
 * RUBRIC B2).
 *
 * WHICH page that is depends first on the deployment, and this file can know that: the billing
 * summary's `hosted` is `isStripeConfigured()`, a fact of the instance rather than of the viewer or
 * the org, and this renders on the server at request time like the page does. On a self-managed
 * instance the page is ONE card, so that card is what paints here — the panel's own component, so
 * the two cannot drift. Drawing the hosted report's skeleton there (#6355) promised three gauges and
 * four sections and was replaced by a 96px notice. On a hosted instance it is the panel's own pending
 * render: the toolbar, Plan & limits' three gauges, the over-time card with its pickers, Resources,
 * and the AI section. Every hosted plan draws those sections; a plan without a feature refuses inside
 * its section, not in place of the page.
 */
export default function UsageLoading() {
	if (!isStripeConfigured()) {
		return (
			<div aria-busy="true">
				<SelfManagedUsageNotice />
			</div>
		);
	}
	return <UsageSkeleton />;
}

// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@repo/ui/skeleton";
import { EarlyAccessSelfManagedNotice } from "@/components/billing/early-access-self-managed-notice";
import { deploymentMode } from "@/lib/billing/config";

/**
 * Instant skeleton for Settings · Billing · Early Access. Without it the route inherited
 * `../loading.tsx`, the billing panel's plan-card skeleton. Mirrors this page: on a self-managed
 * instance that is ONE card — the page's own notice, read from the same `deploymentMode()` fact the
 * page branches on, so the two cannot drift (RUBRIC B2). On the hosted service it is the explainer
 * section, then the request form card.
 */
export default function EarlyAccessLoading() {
	if (deploymentMode() !== "hosted") {
		return (
			<div aria-busy="true">
				<EarlyAccessSelfManagedNotice />
			</div>
		);
	}
	return (
		<div>
			{/* Section heading + explainer card. */}
			<Skeleton className="mb-3 h-5 w-56" />
			<Skeleton className="mb-[18px] h-24 w-full" />

			{/* Section heading + request form. */}
			<Skeleton className="mb-3 h-5 w-36" />
			<Skeleton className="h-80 w-full" />
		</div>
	);
}

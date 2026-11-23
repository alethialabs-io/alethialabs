// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@repo/ui/skeleton";

/**
 * Instant skeleton for Settings · Billing · Early Access. Without it the route inherited
 * `../loading.tsx`, the billing panel's plan-card skeleton. Mirrors this page: the explainer section,
 * then the request form card.
 */
export default function EarlyAccessLoading() {
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

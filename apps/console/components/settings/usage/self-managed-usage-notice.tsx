// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The whole org Usage page on an instance with no hosted billing: one card, nothing metered (#6355).
// Its own module, with no "use client", because TWO renders draw it and must not disagree: the
// panel, once the billing summary says `hosted: false`, and the route's `loading.tsx`, which knows
// the same deployment fact before the page resolves. The loading state used to draw the hosted
// report's skeleton there — three gauges, two side by side in the first card, 807px of sections —
// and the page that replaced it was this single 96px card (release gate: B2 0.066, columns 2 → 1).

import { Card } from "@repo/ui/card";
import { SectionHeading } from "@repo/ui/section-heading";

/** The self-managed Usage notice: usage is a hosted-billing concept, so nothing is metered here. */
export function SelfManagedUsageNotice() {
	return (
		<Card className="p-6">
			<SectionHeading
				title="Self-managed deployment"
				description="This instance isn't connected to hosted billing, so usage isn't metered here."
			/>
		</Card>
	);
}

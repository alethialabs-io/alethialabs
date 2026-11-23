// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The whole Early Access page on a self-managed instance: one card (#7325). A complimentary grant is
// a plan on the hosted service, so a self-managed instance has nothing to request, and the server
// actions behind the request form refuse there. The page used to render the form anyway and let its
// overview read throw, which is an error, not a state (release gate audit leg, `routes.spec.ts`).
//
// Its own module, with no "use client", because TWO renders draw it and must not disagree: the page,
// and the route's `loading.tsx`, which knows the same deployment fact before the page resolves. It is
// the same card the Billing and Usage pages draw on a self-managed instance.

import { Card } from "@repo/ui/card";
import { SectionHeading } from "@repo/ui/section-heading";

/** The self-managed Early Access notice: grants are a hosted-service offer, so there is no form here. */
export function EarlyAccessSelfManagedNotice() {
	return (
		<Card className="p-6">
			<SectionHeading
				title="Self-managed deployment"
				description="This instance isn't connected to hosted billing. Complimentary Early Access is a hosted-service offer, so there is nothing to request here. Enterprise features are unlocked by your license key."
			/>
		</Card>
	);
}

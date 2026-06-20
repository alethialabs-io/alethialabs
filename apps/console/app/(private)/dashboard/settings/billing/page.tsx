// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Suspense } from "react";
import { BillingPanel } from "@/components/settings/billing/billing-panel";
import { SettingsHeader } from "@/components/settings/settings-header";

/** Billing & subscription: plan, upgrade, and the Stripe Customer Portal. */
export default function BillingPage() {
	return (
		<>
			<SettingsHeader
				title="Billing"
				description="Your plan and subscription. Upgrade to unlock teams, governance, and SSO."
			/>
			{/* BillingPanel reads useSearchParams (Checkout return state) → Suspense boundary. */}
			<Suspense>
				<BillingPanel />
			</Suspense>
		</>
	);
}

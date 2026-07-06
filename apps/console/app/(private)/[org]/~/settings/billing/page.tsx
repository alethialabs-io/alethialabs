// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { BillingPanel } from "@/components/settings/billing/billing-panel";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Billing · Settings",
	description: "Plan, payment methods, transactions, and invoices.",
});

/** Billing & subscription: current plan, payment methods, transactions, invoices. */
export default function BillingPage() {
	return <BillingPanel />;
}

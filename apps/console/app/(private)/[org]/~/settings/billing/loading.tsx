// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { BillingSkeleton } from "@/components/settings/billing/billing-skeleton";

/**
 * Instant skeleton for the settings/billing route — the panel's own pending render, so the route
 * skeleton and the page that replaces it have one shape (F008, RUBRIC B2). No title above it.
 */
export default function BillingLoading() {
	return <BillingSkeleton />;
}

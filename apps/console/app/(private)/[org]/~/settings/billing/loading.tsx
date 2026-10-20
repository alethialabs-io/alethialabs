// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { PanelSkeleton } from "@/components/skeletons/page-skeletons";

/** Instant skeleton for the settings/billing route: the billing panel, with no title above it. */
export default function BillingLoading() {
	return <PanelSkeleton lines={5} />;
}

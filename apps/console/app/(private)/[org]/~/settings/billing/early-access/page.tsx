// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { EarlyAccessRequestPanel } from "@/components/billing/early-access-request-panel";
import { EarlyAccessSelfManagedNotice } from "@/components/billing/early-access-self-managed-notice";
import { deploymentMode } from "@/lib/billing/config";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Early Access · Billing · Settings",
	description: "Ask for complimentary Early Access to a paid plan.",
});

/**
 * The complimentary Early Access request (EA-3, #7325). EA-2's purchase refusal for an EU business
 * with a VAT number links here. The panel reads and files through `app/server/actions/early-access.ts`,
 * which requires the billing permission and the hosted service.
 *
 * On a self-managed instance the page is the self-managed notice and the panel is never mounted: the
 * actions refuse there by throwing, and a route must render a state rather than an error. The branch
 * reads the SAME fact the actions' `requireHosted` reads (`deploymentMode()`), so the page cannot offer
 * a form the server would refuse. A hosted viewer without the billing permission still sees the
 * panel's own load error rather than the form.
 */
export default function EarlyAccessPage() {
	if (deploymentMode() !== "hosted") return <EarlyAccessSelfManagedNotice />;
	return <EarlyAccessRequestPanel />;
}

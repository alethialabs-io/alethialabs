// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { EarlyAccessRequestPanel } from "@/components/billing/early-access-request-panel";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Early Access · Billing · Settings",
	description: "Ask for complimentary Early Access to a paid plan.",
});

/**
 * The complimentary Early Access request (EA-3, #7325). EA-2's purchase refusal for an EU business
 * with a VAT number links here. The panel reads and files through `app/server/actions/early-access.ts`,
 * which requires the billing permission and the hosted service; a viewer without either sees the
 * panel's own load error rather than the form.
 */
export default function EarlyAccessPage() {
	return <EarlyAccessRequestPanel />;
}

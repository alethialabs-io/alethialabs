// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { getOrgEvidence } from "@/app/server/actions/evidence";
import { EvidenceClient } from "@/components/evidence/evidence-client";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Evidence",
	description:
		"Proof that your infrastructure is what you provisioned: verification verdicts, drift posture, and recorded waivers across every environment.",
});

/**
 * Evidence route — the org-wide day-2 "keep proving it" roll-up. Renders the default
 * (unfiltered) view on the server for first paint; `loading.tsx` covers the query window.
 * The client then re-fetches through the same server action whenever a filter changes.
 */
export default async function EvidenceRoute() {
	const initial = await getOrgEvidence();
	return <EvidenceClient initial={initial} />;
}

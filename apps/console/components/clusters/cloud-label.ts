// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What a cluster's cloud is CALLED, for the table, the drawer and the filter bar. Its own small
// module so the three share one answer without the bar importing the drawer.

import { PROVIDER_LABELS } from "@repo/ui/provider-icon";
import { globalHref } from "@/lib/routing";

/**
 * A cloud provider slug's display name, or the slug itself for one the label table does not know —
 * never another cloud's name.
 */
export function providerName(slug: string): string {
	return Object.entries(PROVIDER_LABELS).find(([known]) => known === slug)?.[1] ?? slug;
}

/** The cloud a cluster runs on, as the table and the drawer print it; null when it is not known. */
export function cloudLabel(data: { cloud_identities: { provider: string } | null }): string | null {
	const provider = data.cloud_identities?.provider;
	return provider ? providerName(provider) : null;
}

/** The page of the job a cluster's "last run" names. */
export function lastRunHref(orgSlug: string, jobId: string): string {
	return globalHref(orgSlug, `jobs/${jobId}`);
}

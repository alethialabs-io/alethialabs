// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
	keepPreviousData,
	useQuery,
	useQueryClient,
	type UseQueryResult,
} from "@tanstack/react-query";
import { useParams } from "next/navigation";
import {
	listSsoProviders,
	type SsoFilter,
	type SsoProviderRow,
} from "@/app/server/actions/sso";
import { qk } from "./keys";

/** True when the filter would actually narrow the list (drives the shared base key). */
function isActive(f: SsoFilter): boolean {
	return Boolean(f.search?.trim() || f.types?.length || f.statuses?.length);
}

/**
 * The active org's SSO providers, filtered server-side. Previous results are kept while the next
 * query loads so the list doesn't flash; an empty filter reuses the base key the page prefetches.
 */
export function useSsoProvidersQuery(
	filter: SsoFilter = {},
): UseQueryResult<SsoProviderRow[]> {
	const { org } = useParams<{ org: string }>();
	const active = isActive(filter);
	return useQuery({
		queryKey: qk.ssoProviders(org, active ? filter : undefined),
		queryFn: () => listSsoProviders(active ? filter : {}),
		placeholderData: keepPreviousData,
	});
}

/** Invalidate every keyed variant of the org's provider list after a mutation. */
export function useInvalidateSso(): () => void {
	const qc = useQueryClient();
	const { org } = useParams<{ org: string }>();
	return () => {
		void qc.invalidateQueries({ queryKey: ["sso", "providers", org] });
	};
}

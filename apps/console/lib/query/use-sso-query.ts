// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Settings · SSO, the console filter standard's fetch half (#6129, ADR 0005 D1): the provider list
// is the `sso.providers` GET procedure, filtered server-side, and the normalized filter IS its input
// (and so its key). The route prefetches the pristine list and the link's filtered list, so the
// first paint carries data. Live: an `access` hint (a provider was registered, edited, verified or
// removed — `sso_provider`'s trigger) invalidates `orpc.sso.key()` (lib/query/topics.ts).

import { keepPreviousData, useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { SsoFilter, SsoProviderRow } from "@/app/server/actions/sso";
import { retryUnlessRefused } from "@/lib/rpc/refusal";
import { orpc } from "@/lib/rpc/client";

/**
 * The addressed org's SSO providers for `filter`, filtered server-side. Previous results are kept
 * while the next answer loads (the caller dims them, `isPlaceholderData`); `{}` is the pristine
 * list the facet counts are taken over. A refusal is never retried: it answers the same twice.
 */
export function useSsoProvidersQuery(filter: SsoFilter = {}): UseQueryResult<SsoProviderRow[]> {
	return useQuery(
		orpc.sso.providers.queryOptions({
			input: filter,
			placeholderData: keepPreviousData,
			retry: retryUnlessRefused,
		}),
	);
}

/** Every SSO read's key prefix — what a provider write invalidates. */
export function ssoReadKeys() {
	return [orpc.sso.key()];
}

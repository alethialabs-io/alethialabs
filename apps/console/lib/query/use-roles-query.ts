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
import { listRoles, type RoleRow } from "@/app/server/actions/roles";
import { qk } from "./keys";

/**
 * The active org's custom roles, filtered server-side by `search` (name / description /
 * permission key). Previous results are kept while the next query loads so the list doesn't
 * flash; with no `search` the key is the shared base the page prefetches.
 */
export function useRolesQuery(search?: string): UseQueryResult<RoleRow[]> {
	const { org } = useParams<{ org: string }>();
	const q = search?.trim() || undefined;
	return useQuery({
		queryKey: qk.roles(org, q),
		queryFn: () => listRoles(q),
		placeholderData: keepPreviousData,
	});
}

/** Invalidate every keyed variant of the org's roles list after a mutation. */
export function useInvalidateRoles(): () => void {
	const qc = useQueryClient();
	const { org } = useParams<{ org: string }>();
	return () => {
		void qc.invalidateQueries({ queryKey: ["roles", org] });
	};
}

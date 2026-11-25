// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Settings · Roles. #6129 (ADR 0005 D1): both reads are GET procedures the route prefetches —
// `members.roleCatalog` (built-ins, permission catalog, entitlement, manage check), read here, and
// `members.roles` (the custom roles), which the rail pages through `useKeysetList` itself
// (lib/query/README.md → "Paging"; LST-8 #7490). Live: an `access` hint (a role, its permissions or
// a grant changed) invalidates both.

import { useQuery } from "@tanstack/react-query";
import { retryUnlessRefused } from "@/components/settings/members/people-reads";
import { orpc } from "@/lib/rpc/client";

/** The Roles page's catalog: built-in roles with grant counts, permissions, entitlement, manage. */
export function useRoleCatalogQuery() {
	return useQuery(
		orpc.members.roleCatalog.queryOptions({ input: undefined, retry: retryUnlessRefused }),
	);
}

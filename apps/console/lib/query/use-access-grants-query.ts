// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

// Settings · Access's grant builder read. The grants LIST pages through
// `useKeysetList(orpc.members.grants, …)` in the manager (lib/query/README.md → "Paging"; LST-8
// #7490), which is where the filter standard's list wiring lives; its search reaches a grant's
// SCOPE by name (`queryAccessGrantsPage` joins projects, runners, cloud identities, teams, users).
//
// #6129 (ADR 0005 D1): `members.grantOptions` is a GET procedure the org route prefetches. Live: an
// `access` hint (a grant or a role changed) invalidates it.

import { useQuery } from "@tanstack/react-query";
import { retryUnlessRefused } from "@/components/settings/members/people-reads";
import { orpc } from "@/lib/rpc/client";

/** The grant builder's principals, roles, permissions and scopes. */
export function useGrantOptionsQuery(enabled = true) {
	return useQuery(
		orpc.members.grantOptions.queryOptions({ input: undefined, enabled, retry: retryUnlessRefused }),
	);
}

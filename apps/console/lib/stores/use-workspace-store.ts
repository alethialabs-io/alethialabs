// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { create } from "zustand";
import {
	getWorkspaceContext,
	setActiveOrganization,
	type WorkspaceOrg,
} from "@/app/server/actions/workspace";
import type { Entitlements } from "@/lib/authz/types";
import { PERSONAL_ORG_SLUG } from "@/lib/routing";

interface WorkspaceStore {
	/** The org the session is scoped to (drives the PDP + RLS); null until loaded. */
	activeOrgId: string | null;
	/** Orgs the user can switch to (community = a single "Personal" workspace). */
	organizations: WorkspaceOrg[];
	/** Feature entitlements — gate the switcher's "create org" + the admin surfaces. */
	entitlements: Entitlements | null;
	isLoading: boolean;
	fetchWorkspace: () => Promise<void>;
	/** Persist the active org server-side, then update local state. */
	switchOrg: (orgId: string) => Promise<void>;
}

export const useWorkspaceStore = create<WorkspaceStore>((set) => ({
	activeOrgId: null,
	organizations: [],
	entitlements: null,
	isLoading: false,
	fetchWorkspace: async () => {
		set({ isLoading: true });
		try {
			const ctx = await getWorkspaceContext();
			set({
				activeOrgId: ctx.activeOrgId,
				organizations: ctx.organizations,
				entitlements: ctx.entitlements,
			});
		} catch {
			// Unauthenticated / transient — keep defaults; the layout still renders.
		} finally {
			set({ isLoading: false });
		}
	},
	switchOrg: async (orgId) => {
		await setActiveOrganization(orgId);
		set({ activeOrgId: orgId });
	},
}));

/**
 * The active organization's URL slug (for building `/{org}/…` drilldown hrefs).
 * Falls back to the reserved personal `~` segment while loading or in personal scope.
 */
export function useActiveOrgSlug(): string {
	return useWorkspaceStore(
		(s) =>
			s.organizations.find((o) => o.id === s.activeOrgId)?.slug ??
			PERSONAL_ORG_SLUG,
	);
}

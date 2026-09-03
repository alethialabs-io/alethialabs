// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useParams } from "next/navigation";
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
	/** Hosted SaaS vs self-managed deployment — gates platform-fleet surfaces. */
	isHosted: boolean;
	isLoading: boolean;
	fetchWorkspace: () => Promise<void>;
	/** Persist the active org server-side, then update local state. */
	switchOrg: (orgId: string) => Promise<void>;
}

export const useWorkspaceStore = create<WorkspaceStore>((set) => ({
	activeOrgId: null,
	organizations: [],
	entitlements: null,
	isHosted: false,
	isLoading: false,
	fetchWorkspace: async () => {
		set({ isLoading: true });
		try {
			const ctx = await getWorkspaceContext();
			set({
				activeOrgId: ctx.activeOrgId,
				organizations: ctx.organizations,
				entitlements: ctx.entitlements,
				isHosted: ctx.isHosted,
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

/** Whether the console is the hosted SaaS (vs a self-managed/community deployment). */
export function useIsHosted(): boolean {
	return useWorkspaceStore((s) => s.isHosted);
}

/**
 * The active organization's URL slug (for building `/{org}/…` drilldown hrefs).
 *
 * **The URL is authoritative.** Every consumer of this hook renders inside
 * `app/(private)/[org]/layout.tsx`, so `useParams().org` IS the org segment the
 * address bar already shows. Reading it makes an href agree with the page it is
 * painted on BY CONSTRUCTION — there is no window in which the two disagree.
 *
 * That window was #4089, a tenancy defect. This hook used to read the store alone,
 * and `activeOrgId` is `null` until `fetchWorkspace()` resolves — so the lookup
 * missed and it returned the reserved personal `~` for "still loading" as well as
 * for "actually in personal scope". The two states are not distinguishable in the
 * value, and the old doc comment said so out loud ("while loading or in personal
 * scope") without registering that the first case is wrong.
 *
 * The consequence was not a cosmetic flicker. During hydration the sidebar painted
 * `/~/~/…` hrefs while the address bar said `/acme/…`; Next prefetches every link
 * in the viewport, each prefetch renders `[org]/layout.tsx`, and that layout calls
 * `resolveOrgScope("~")` — which WRITES `session.active_organization_id`. So a
 * speculative GET the user never made moved their tenant to personal, and their
 * next write landed in the personal org, invisible to the org and every teammate,
 * with no error. Run 33710964528's trace caught 36 `/~/~/` requests, every one
 * carrying `next-router-prefetch: 1` and none of them a navigation.
 *
 * Fixing the href is the whole fix, and it has to be, because the write itself
 * cannot be gated: Next 16.3.3 hides `next-router-prefetch` from userland — see the
 * comment on `resolveOrgScope` for the citation. Once every prefetchable href names
 * the org the address bar names, a speculative resolve can only re-assert the org
 * the user is already in, which is what a real navigation to that page would write
 * anyway. Idempotent, therefore harmless.
 *
 * The store remains the fallback for routes with no `[org]` segment (`/onboarding`,
 * `/dashboard`, the CLI hand-off), where `useParams()` has no `org` to give and the
 * session's selection is the only answer available.
 */
export function useActiveOrgSlug(): string {
	// `useParams()` returns null outside a router context (an isolated component test)
	// and `string[]` for a catch-all segment, so narrow the value rather than trusting
	// the type argument — it annotates the shape, it does not verify it.
	const params = useParams<{ org?: string }>();
	const urlOrg = typeof params?.org === "string" ? params.org : null;
	const fromSession = useWorkspaceStore(
		(s) =>
			s.organizations.find((o) => o.id === s.activeOrgId)?.slug ??
			PERSONAL_ORG_SLUG,
	);
	return urlOrg ?? fromSession;
}

// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useEffect } from "react";
import { create } from "zustand";
import { setActiveOrganization } from "@/app/server/actions/workspace";
import type { Entitlements } from "@/lib/authz/types";
import { getQueryClient } from "@/lib/query/client";
import { orpc, rpcClient, tenantSegment } from "@/lib/rpc/client";
import type { WorkspaceContext, WorkspaceOrg } from "@/lib/rpc/procedures/workspace";

/**
 * Where the workspace load stands (#5895).
 *
 * - `idle` — never asked. The server render and every first client paint are here, so a surface
 *   keyed on this state renders the same thing on both and cannot cause a hydration mismatch.
 * - `loading` — a `fetchWorkspace()` is in flight.
 * - `loaded` — the last load answered; `entitlements` and the rest are the server's.
 * - `failed` — the last load threw. Whatever an earlier load set is kept (a stale answer is still
 *   an answer); if none ever succeeded, `entitlements` is still `null`, so every `useEntitlement`
 *   gate keeps failing closed — no paid content, no upsell. This state exists so a surface can say
 *   so and offer a retry instead of waiting forever on a load that will not come: before it, a
 *   failure put the store back in exactly the never-fetched shape.
 */
export type WorkspaceLoadStatus = "idle" | "loading" | "loaded" | "failed";

/** Bumped by every `fetchWorkspace()`, so only the latest call's answer settles the store. */
let loadGeneration = 0;

interface WorkspaceStore {
	/** The org the session is scoped to (drives the PDP + RLS); null until loaded. */
	activeOrgId: string | null;
	/** Orgs the user can switch to (community = a single "Personal" workspace). */
	organizations: WorkspaceOrg[];
	/** Feature entitlements — gate the switcher's "create org" + the admin surfaces. */
	entitlements: Entitlements | null;
	/** Hosted SaaS vs self-managed deployment — gates platform-fleet surfaces. */
	isHosted: boolean;
	/** Where the workspace load stands — see `WorkspaceLoadStatus`. */
	loadStatus: WorkspaceLoadStatus;
	/** `loadStatus === "loading"`, kept for existing readers; it cannot tell idle from failed. */
	isLoading: boolean;
	/** Load (or re-load) the workspace context. Safe to call again after a failure: it is the retry. */
	fetchWorkspace: () => Promise<void>;
	/** Settle the store from a context the caller already holds (the layout's hydrated prefetch). */
	applyWorkspace: (ctx: WorkspaceContext) => void;
	/** Say the load failed (the hydrated query errored), keeping whatever an earlier load set. */
	markFailed: () => void;
	/** Persist the active org server-side, then update local state. */
	switchOrg: (orgId: string) => Promise<void>;
}

/** The store's settled state for a workspace context. */
function loaded(ctx: WorkspaceContext): Partial<WorkspaceStore> {
	return {
		activeOrgId: ctx.activeOrgId,
		organizations: ctx.organizations,
		entitlements: ctx.entitlements,
		isHosted: ctx.isHosted,
		loadStatus: "loaded",
		isLoading: false,
	};
}

export const useWorkspaceStore = create<WorkspaceStore>((set) => ({
	activeOrgId: null,
	organizations: [],
	entitlements: null,
	isHosted: false,
	loadStatus: "idle",
	isLoading: false,
	fetchWorkspace: async () => {
		loadGeneration += 1;
		const generation = loadGeneration;
		set({ loadStatus: "loading", isLoading: true });
		try {
			const ctx = await rpcClient.workspace.context();
			// A later call (a retry, or a refresh after a billing change) owns the outcome.
			if (generation !== loadGeneration) return;
			set(loaded(ctx));
			// Write the answer into the QUERY too: that is what the switchers render from, and setting
			// its data also clears a failed query's error, so the shell's sync
			// (`useWorkspaceStoreSync`) does not mark the store failed again after a successful retry.
			// Same tenant partition as `app/providers.tsx`, so the answer lands in the cache of the org
			// it was asked of. (Called directly rather than through `fetchQuery`, which would hand a
			// second call the first call's in-flight promise and break "the latest call wins".)
			getQueryClient(tenantSegment(window.location.pathname)).setQueryData(
				orpc.workspace.context.queryKey(),
				ctx,
			);
		} catch {
			// Unauthenticated / transient — keep what we had, so the layout still renders, but say
			// the load FAILED rather than falling back to the never-fetched shape (#5895).
			if (generation !== loadGeneration) return;
			set({ loadStatus: "failed", isLoading: false });
		}
	},
	applyWorkspace: (ctx) => set(loaded(ctx)),
	markFailed: () => set({ loadStatus: "failed", isLoading: false }),
	switchOrg: async (orgId) => {
		await setActiveOrganization(orgId);
		set({ activeOrgId: orgId });
	},
}));

/**
 * The workspace context as a query (ADR 0005 D5, #6114): the `[org]` layout prefetches it and
 * hydrates it, so on the server render AND on the first client paint this already holds the org,
 * its plan and the user's org list — no "Personal" placeholder, no request of its own. The store
 * above is the legacy surface for the entitlement gates; `useWorkspaceStoreSync()` settles it from
 * this query, never from a second fetch.
 */
export function useWorkspaceContextQuery(): UseQueryResult<WorkspaceContext> {
	return useQuery(workspaceContextQuery());
}

/** The workspace-context query: the key the layout prefetches, read through the GET procedure. */
function workspaceContextQuery() {
	return {
		queryKey: orpc.workspace.context.queryKey(),
		queryFn: () => rpcClient.workspace.context(),
	};
}

/**
 * The org the ADDRESS names, from the hydrated workspace context — the org a header renders as
 * "you are here". Matched on the URL slug (the address decides the tenant, #4133), then on the
 * request's org id, so it agrees with the page it is painted on. `null` only while the context is
 * not there (a failed prefetch being retried): a caller renders a placeholder, never a guessed org.
 * The topbar's mobile org identity reads this (F028, pending its design decision in #6135).
 */
export function useActiveWorkspaceOrg(): WorkspaceOrg | null {
	const slug = useActiveOrgSlug();
	const { data } = useWorkspaceContextQuery();
	if (!data) return null;
	return (
		data.organizations.find((o) => o.slug === slug) ??
		data.organizations.find((o) => o.id === data.activeOrgId) ??
		null
	);
}

/**
 * Settles the store from the hydrated workspace query — the store's only load on a page view.
 * Mounted once, by the app shell. Before #6114 the shell AND the org switcher each called
 * `fetchWorkspace()` on mount: two server-action POSTs for data the layout could have sent.
 *
 * A FAILED query with no data is a failed load (#5895): when the layout's prefetch failed and the
 * client's own query errors too, the store says `failed`, so a surface waiting on it shows an error and a Retry
 * (`fetchWorkspace()`, which refetches this query) instead of a skeleton that never ends.
 */
export function useWorkspaceStoreSync(): void {
	const { data, isError } = useWorkspaceContextQuery();
	useEffect(() => {
		if (data) useWorkspaceStore.getState().applyWorkspace(data);
	}, [data]);
	// Only a query with NOTHING to show is a failed load. A background refetch that fails keeps its
	// last good data, and the store keeps serving it as loaded.
	useEffect(() => {
		if (isError && !data) useWorkspaceStore.getState().markFailed();
	}, [isError, data]);
}

/** Where the workspace load stands — `failed` is the one state a surface must not wait out. */
export function useWorkspaceLoadStatus(): WorkspaceLoadStatus {
	return useWorkspaceStore((s) => s.loadStatus);
}

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
 * ## There is deliberately NO session fallback
 *
 * An earlier version of this fix kept the old store read as a fallback for routes with
 * no `[org]` segment. That was a **positional** fix, not a causal one: the fallback
 * still answered `~` while `activeOrgId` was null, so the defect was intact inside it
 * and merely sat somewhere it did not currently fire. Worse, its doc invited the next
 * reader to add a store-derived `<Link>` on a non-`[org]` route — which is #4089
 * verbatim, since Next would prefetch the `/~/…` it painted during hydration.
 *
 * It was also dead code. `AppShell` is imported by exactly one module,
 * `app/(private)/[org]/layout.tsx`, and every consumer of this hook renders inside it.
 * The routes that fallback named render no consumer: `/onboarding` is under `(public)`,
 * `/dashboard` is a server-only `redirect()` with no client tree, and the CLI hand-off
 * imports none of this. So the branch could not execute, and tests pinning it pinned a
 * path that cannot occur. (`tests/hooks/use-active-org-slug.test.tsx` now asserts that
 * one-importer fact, because it is the premise this contract rests on.)
 *
 * So the fallback is gone and the absence of the segment is an error. Calling this
 * where there is no `{org}` in the URL has no correct answer — every value it could
 * return is a claim about which tenant the user is in, and `~` is a REAL tenant, not a
 * null. Refusing is the only honest branch, and it is what makes the fix causal: the
 * ambiguous value no longer exists anywhere to be rendered into an href.
 *
 * This also removes the last `?? PERSONAL_ORG_SLUG` alias in this file. `WorkspaceOrg.slug`
 * is nullable (`organizations.slug` is `text().unique()` with no notNull), so that
 * coalesce absorbed a real org with no slug onto the personal segment as well as a
 * find-miss — the same aliasing the switcher was fixed for.
 *
 * Note it no longer reads the store at all; it stays in this module because it is still
 * the workspace's org accessor and moving it would touch 19 imports for no behaviour.
 */
export function useActiveOrgSlug(): string {
	// `useParams()` returns null outside a router context (an isolated component test)
	// and `string[]` for a catch-all segment, so narrow the value rather than trusting
	// the type argument — it annotates the shape, it does not verify it.
	const params = useParams<{ org?: string }>();
	const org = params?.org;
	if (typeof org !== "string" || org.length === 0) {
		throw new Error(
			"useActiveOrgSlug() was called outside the /[org] route tree, so there is no org " +
				"segment to read. Do NOT reintroduce a session fallback here: it can only answer " +
				"`~`, which is a real tenant, and a prefetch of the href built from it moves the " +
				"user's active organization (#4089). Take the org from the route instead.",
		);
	}
	return org;
}

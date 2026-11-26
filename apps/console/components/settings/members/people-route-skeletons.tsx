"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The SYNCHRONOUS loading forms of the four people & access routes (members, teams, access, SSO).
//
// Each `loading.tsx` used to be an `async` server component that awaited the actor to learn the
// plan before drawing anything — and an async `loading.tsx` is banned (decision CON-M4, RUBRIC
// rule 4): it is itself a suspension, so the route shows nothing while the skeleton that was meant
// to cover the wait waits. The gate the skeleton keys on now comes from the workspace store the org
// layout loads, read on the client:
//
//   · known (every navigation after the first in a session) — the exact shape the page will draw,
//     the list or the upsell, the manager's columns or the member's;
//   · not yet known (a hard load of this route) — the entitled shape, the one every org that can
//     use the page sees. An org without the plan sees that skeleton give way to its upsell; that one
//     case is the cost of drawing at once instead of waiting.

import { PanelSkeleton } from "@/components/skeletons/page-skeletons";
import { SkeletonRoot } from "@/components/skeleton/skeleton-root";
import { useEntitlement } from "@/components/settings/enterprise-gate";
import { PageToolbarSkeleton } from "@repo/ui/page-toolbar";
import { Skeleton } from "@repo/ui/skeleton";
import { PeopleListSkeleton, PeopleUpsellSkeleton } from "./people-skeleton";

/**
 * Members: the toolbar (count, one line, Invite), the filter bar (search, Status, Role) and the
 * table — Member, Role, Teams, Status, Last active, plus the select and actions columns an org with
 * the `organizations` entitlement gets (the entitlement `members.gate` answers `canManage` from).
 */
export function MembersRouteSkeleton() {
	const organizations = useEntitlement("organizations");
	return <PeopleListSkeleton facets={2} columns={organizations === false ? 5 : 7} />;
}

/**
 * Teams: with the `teams` entitlement, the toolbar (count, one line, Create team), the filter bar
 * (search, Size) and the table (Team, Members, the row menu); without it, the toolbar and the
 * upsell's box (F021).
 */
export function TeamsRouteSkeleton() {
	const teams = useEntitlement("teams");
	return teams === false ? <PeopleUpsellSkeleton /> : <PeopleListSkeleton facets={1} columns={3} />;
}

/**
 * Access: with the `customRoles` entitlement, the inheritance note, the toolbar (count, one line,
 * Add grant), the filter bar (search, Scope, Roles, Effect) and the table (Principal, Role, Scope,
 * Effective reach, Granted, the row menu); without it, the note and the upsell (F021).
 */
export function AccessRouteSkeleton() {
	const customRoles = useEntitlement("customRoles");
	return customRoles === false ? (
		<PeopleUpsellSkeleton lead toolbar={false} />
	) : (
		<PeopleListSkeleton lead facets={3} columns={6} />
	);
}

/**
 * SSO: with the `sso` entitlement, the manager — the toolbar (count, one line, Connect provider),
 * the filter bar (search, Protocol, Status), the provider rail beside the detail pane, and the SCIM
 * card under them (R6 E-22: it used to be one plain panel, so the page jumped into a split and grew a
 * card when it arrived); without it the page's whole body is the upsell, so the skeleton is the
 * upsell's box alone (#6132, F021).
 *
 * The rail and pane split at `lg`, as `SsoManager` does — a two-pane layout, stacked on a phone.
 */
export function SsoRouteSkeleton() {
	const sso = useEntitlement("sso");
	if (sso === false) return <PeopleUpsellSkeleton toolbar={false} />;
	return (
		<SkeletonRoot>
			<PageToolbarSkeleton className="mb-4" actions={1} />
			<div aria-hidden className="mb-4 flex flex-wrap items-center gap-2.5">
				<Skeleton className="h-8 w-[240px] max-w-[380px] flex-1 rounded-md" />
				<Skeleton className="h-8 w-28 rounded-md" />
				<Skeleton className="h-8 w-28 rounded-md" />
			</div>
			<div aria-hidden className="mb-4 grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
				<div className="space-y-1 rounded-lg border border-border bg-surface p-2 shadow-sm">
					{[0, 1].map((i) => (
						<div key={i} className="flex items-center gap-2.5 px-2.5 py-2">
							<div className="min-w-0 flex-1 space-y-1.5">
								<Skeleton className="h-3.5 w-28" />
								<Skeleton className="h-2.5 w-36" />
							</div>
							<Skeleton className="h-4 w-16 rounded-full" />
						</div>
					))}
				</div>
				<PanelSkeleton lines={5} />
			</div>
			<div aria-hidden data-slot="sso-scim-skeleton" className="space-y-2 rounded-lg border border-border bg-surface px-5 py-4 shadow-sm">
				<Skeleton className="h-4 w-36" />
				<Skeleton className="h-3 w-full max-w-[560px]" />
			</div>
		</SkeletonRoot>
	);
}

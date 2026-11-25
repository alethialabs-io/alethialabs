// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { and, eq } from "drizzle-orm";
import { isPeopleRead } from "@/components/settings/members/people-reads";
import { type NormalizedTeamsQuery, teamsQueryFromUrl } from "@/components/settings/teams/teams-filters";
import { type TeamsGate, teamsGateForRole } from "@/components/settings/teams/teams-gate";
import { TeamsList } from "@/components/settings/teams/teams-list";
import { getEntitlements } from "@/lib/authz/entitlements";
import { currentActor } from "@/lib/authz/guard";
import type { Actor } from "@/lib/authz/types";
import { getServiceDb } from "@/lib/db";
import { member } from "@/lib/db/schema";
import { getQueryClient } from "@/lib/query/client";
import { paramReader } from "@/lib/query/filter-url-codec";
import { serverOrpc } from "@/lib/rpc/server";
import { pageMetadata } from "@/lib/seo/page-metadata";

export const metadata = pageMetadata({
	title: "Teams · Settings",
	description: "Teams and their members within your organization.",
});

/**
 * What this viewer may change on the page, decided from their ACTIVE membership role with the same
 * access-control statements the team writes check (`teams-gate.ts`). The personal workspace has no
 * organization membership and no teams to write; a suspended member's writes are refused, so their
 * controls are too.
 */
async function readTeamsGate(actor: Actor): Promise<TeamsGate> {
	if (actor.orgId === actor.userId) return teamsGateForRole(null);
	const [row] = await getServiceDb()
		.select({ role: member.role, status: member.status })
		.from(member)
		.where(and(eq(member.organizationId, actor.orgId), eq(member.userId, actor.userId)))
		.limit(1);
	return teamsGateForRole(row && row.status === "active" ? row.role : null);
}

/**
 * Settings · Teams route (#6129, the jobs slice's shape). Prefetches the FIRST PAGE of the
 * `members.teams` walk for the pristine view and for the link's filters, under the infinite key
 * `useKeysetList` builds (LST-8 #7490), in-process through the read router, so the first paint is
 * the list and the browser fetches nothing on mount.
 *
 * The `teams` entitlement is resolved HERE, from the same actor, and handed down: the workspace
 * store's copy is `null` until it loads after hydration, so a client-side gate showed every org
 * neither the button nor the upsell for that round trip (#5864) — and decided the create button
 * on the client at all (F017). So is what the viewer may CHANGE (`gate`, R6 E-08): a control they
 * cannot use is disabled with its reason from the first paint, never offered and then refused.
 */
export default async function TeamsPage({
	searchParams,
}: {
	params: Promise<{ org: string }>;
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const filtered = teamsQueryFromUrl(paramReader(await searchParams));
	const actor = await currentActor();
	const { teams } = getEntitlements(actor);
	const queryClient = getQueryClient();
	const rpc = serverOrpc();
	/** The first page of one filter's walk, under the infinite key `useKeysetList` reads. */
	const firstPage = (filter: NormalizedTeamsQuery) =>
		queryClient.prefetchInfiniteQuery(
			rpc.members.teams.infiniteOptions({
				input: (cursor: string | null) => (cursor === null ? filter : { ...filter, cursor }),
				initialPageParam: null,
				getNextPageParam: (last) => last.nextCursor,
			}),
		);
	const [gate] = await Promise.all([readTeamsGate(actor), firstPage({}), firstPage(filtered)]);

	return (
		<HydrationBoundary state={dehydrate(queryClient, { shouldDehydrateQuery: isPeopleRead })}>
			<TeamsList entitled={teams} gate={gate} />
		</HydrationBoundary>
	);
}

// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	PeopleListSkeleton,
	PeopleUpsellSkeleton,
} from "@/components/settings/members/people-skeleton";
import { getEntitlements } from "@/lib/authz/entitlements";
import { currentActor } from "@/lib/authz/guard";

/**
 * Instant skeleton for the settings/teams route. With the `teams` entitlement it is the list's own
 * shape — the toolbar (count, one line, Create team), the filter bar (search, Size) and the table
 * (Team, Members, the row menu). Without it the page's body is the upsell (F021), so the skeleton
 * is the toolbar and the upsell's box, not a table that never arrives. The entitlement is the one
 * the page itself resolves, from the request-cached actor.
 */
export default async function TeamsLoading() {
	const { teams } = getEntitlements(await currentActor());
	return teams ? <PeopleListSkeleton facets={1} columns={3} /> : <PeopleUpsellSkeleton />;
}

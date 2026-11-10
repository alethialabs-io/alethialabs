// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	PeopleListSkeleton,
	PeopleUpsellSkeleton,
} from "@/components/settings/members/people-skeleton";
import { getEntitlements } from "@/lib/authz/entitlements";
import { currentActor } from "@/lib/authz/guard";

/**
 * Instant skeleton for a project's settings/access route (#6320). Without it this route fell back to
 * the project settings' generic skeleton (two bars and a 160px box), which matched neither of the
 * page's two shapes. With the `customRoles` entitlement it is the page's own shape — the project
 * note, the toolbar (count, one line, Add grant), the filter bar (search, Roles, Effect: no Scope
 * facet, since the list is already scoped to this project) and the six-column table. Without it the
 * body is the note and the upsell (F021). The entitlement is the one the page resolves, from the
 * request-cached actor.
 */
export default async function ProjectAccessLoading() {
	const { customRoles } = getEntitlements(await currentActor());
	return customRoles ? (
		<PeopleListSkeleton lead facets={2} columns={6} />
	) : (
		<PeopleUpsellSkeleton lead toolbar={false} />
	);
}

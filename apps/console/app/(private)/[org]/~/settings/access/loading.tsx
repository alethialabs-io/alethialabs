// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import {
	PeopleListSkeleton,
	PeopleUpsellSkeleton,
} from "@/components/settings/members/people-skeleton";
import { getEntitlements } from "@/lib/authz/entitlements";
import { currentActor } from "@/lib/authz/guard";

/**
 * Instant skeleton for the settings/access route. With the `customRoles` entitlement it is the
 * page's own shape — the inheritance note, the toolbar (count, one line, Add grant), the filter bar
 * (search, Scope, Roles, Effect) and the table (Principal, Role, Scope, Effective reach, Granted,
 * the row menu). Without it the body is the inheritance note and the upsell (F021). The
 * entitlement is the one the page resolves, from the request-cached actor.
 */
export default async function AccessLoading() {
	const { customRoles } = getEntitlements(await currentActor());
	return customRoles ? (
		<PeopleListSkeleton lead facets={3} columns={6} />
	) : (
		<PeopleUpsellSkeleton lead toolbar={false} />
	);
}

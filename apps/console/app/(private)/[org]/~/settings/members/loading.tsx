// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { PeopleListSkeleton } from "@/components/settings/members/people-skeleton";
import { getEntitlements } from "@/lib/authz/entitlements";
import { currentActor } from "@/lib/authz/guard";

/**
 * Instant skeleton for the settings/members route, in the table's own shape: the toolbar (count,
 * one line, Invite), the filter bar (search, Status, Role) and the table — Member, Role, Teams,
 * Status, Last active, plus the select and actions columns an org with the `organizations`
 * entitlement gets (the same entitlement `members.gate` answers `canManage` from). `currentActor()`
 * is request-cached, so this costs the page nothing it was not about to ask.
 */
export default async function MembersLoading() {
	const { organizations } = getEntitlements(await currentActor());
	return <PeopleListSkeleton facets={2} columns={organizations ? 7 : 5} />;
}

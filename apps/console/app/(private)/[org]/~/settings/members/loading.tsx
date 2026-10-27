// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { PeopleListSkeleton } from "@/components/settings/members/people-skeleton";

/**
 * Instant skeleton for the settings/members route, in the table's own shape: the toolbar (count,
 * one line, Invite), the filter bar (search, Status, Role) and the table — Member, Role, Teams,
 * Status, Last active. The management columns (select, actions) are drawn only once the gate has
 * answered, so the skeleton draws the columns every viewer sees.
 */
export default function MembersLoading() {
	return <PeopleListSkeleton facets={2} columns={5} />;
}

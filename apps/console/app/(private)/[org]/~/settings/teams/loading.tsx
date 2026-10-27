// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { PeopleListSkeleton } from "@/components/settings/members/people-skeleton";

/**
 * Instant skeleton for the settings/teams route, in the list's own shape: the toolbar (count, one
 * line, Create team), the filter bar (search, Size) and the table — Team, Members, and the row
 * menu. It used to draw a free-form panel, which is not what lands (B2).
 */
export default function TeamsLoading() {
	return <PeopleListSkeleton facets={1} columns={3} />;
}

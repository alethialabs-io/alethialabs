// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { PeopleListSkeleton } from "@/components/settings/members/people-skeleton";

/**
 * Instant skeleton for the settings/access route, in the page's own shape: the inheritance note,
 * the toolbar (count, one line, Add grant), the filter bar (search, Scope, Roles, Effect) and the
 * table — Principal, Role, Scope, Effective reach, Granted, and the row menu.
 */
export default function AccessLoading() {
	return <PeopleListSkeleton lead facets={3} columns={6} />;
}

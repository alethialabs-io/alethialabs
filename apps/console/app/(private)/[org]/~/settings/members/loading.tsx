// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { MembersRouteSkeleton } from "@/components/settings/members/people-route-skeletons";

/**
 * Instant skeleton for the settings/members route, in the table's own shape (the toolbar, the filter
 * bar and the table, with the manager's columns when the plan gives them). Synchronous (CON-M4): the
 * gate comes from the workspace store, not from awaiting the actor — see `people-route-skeletons`.
 */
export default function MembersLoading() {
	return <MembersRouteSkeleton />;
}

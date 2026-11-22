"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useEntitlement } from "@/components/settings/enterprise-gate";
import {
	PeopleListSkeleton,
	PeopleUpsellSkeleton,
} from "@/components/settings/members/people-skeleton";

/**
 * Instant skeleton for a project's settings/access route (#6320), in one of the page's two shapes.
 * With the `customRoles` entitlement: the project note, the toolbar (count, one line, Add grant), the
 * filter bar (search, Roles, Effect — no Scope facet, the list is already this project's) and the
 * six-column table. Without it: the note and the upsell (F021).
 *
 * Synchronous (decision CON-M4, R6 F-22), as the org Access route's is: the entitlement comes from
 * the workspace store the org layout loads, not from awaiting the actor. Not yet known (a hard load
 * of this route), it draws the entitled shape; an org without the plan sees that give way to the
 * upsell.
 */
export default function ProjectAccessLoading() {
	const customRoles = useEntitlement("customRoles");
	return customRoles === false ? (
		<PeopleUpsellSkeleton lead toolbar={false} />
	) : (
		<PeopleListSkeleton lead facets={2} columns={6} />
	);
}

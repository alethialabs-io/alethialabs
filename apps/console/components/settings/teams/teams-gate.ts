// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What the viewer may change on the Teams page, answered with the SAME question the writes ask.
//
// Every team write goes to Better Auth's organization endpoints, and each one asks the organization
// plugin's access control (`hasPermission`) about the caller's membership role before it does
// anything (`better-auth/dist/plugins/organization/routes/crud-team.mjs`):
//
//   create a team       → `team: ["create"]`
//   rename a team       → `team: ["update"]`
//   delete a team       → `team: ["delete"]`
//   add / remove people → `member: ["update"]`
//
// The roles those statements are read from are `orgRoles` in `lib/authz/org-access-control.ts`. This
// file reads them from there rather than restating which role may do what, because WHICH ROLES MAY
// MANAGE TEAMS IS AN OPEN MAINTAINER DECISION (#7050): when it is made, `orgRoles` changes and every
// control here follows it with no edit to this file. Until then no role names a `team` statement, so
// create, rename and delete are refused for every role, and this page says so on the control instead
// of offering a button that ends in a toast (R6 E-08).

import { lookup } from "@/lib/typed-object";
import { orgRoles } from "@/lib/authz/org-access-control";

/** What the Teams page's controls may do for this viewer. */
export interface TeamsGate {
	/** Create a team (`team:create`). */
	canCreate: boolean;
	/** Rename a team (`team:update`). */
	canRename: boolean;
	/** Delete a team (`team:delete`). */
	canDelete: boolean;
	/** Add people to a team and remove them (`member:update`). */
	canEditRoster: boolean;
}

/** The gate for a viewer the server could not place in the organization: nothing is writable. */
export const NO_TEAM_WRITES: TeamsGate = {
	canCreate: false,
	canRename: false,
	canDelete: false,
	canEditRoster: false,
};

/** Whether one role name, as `orgRoles` defines it, holds `action` on `resource`. */
function roleHolds(roleName: string, resource: string, action: string): boolean {
	const role = lookup(orgRoles, roleName);
	if (!role) return false;
	const statements: { readonly [resource: string]: readonly string[] | undefined } = role.statements;
	return statements[resource]?.includes(action) ?? false;
}

/**
 * Whether a stored membership role holds `action` on `resource`. `member.role` may list several
 * roles separated by commas; the plugin grants a permission when ANY listed role holds it, so this
 * does the same. A role name `orgRoles` does not define holds nothing, as it does in the plugin.
 */
export function membershipHolds(storedRole: string, resource: string, action: string): boolean {
	return storedRole
		.split(",")
		.map((part) => part.trim())
		.some((part) => part !== "" && roleHolds(part, resource, action));
}

/** The Teams page's gate for a viewer whose membership role is `storedRole` (null: not a member). */
export function teamsGateForRole(storedRole: string | null): TeamsGate {
	if (storedRole === null) return NO_TEAM_WRITES;
	return {
		canCreate: membershipHolds(storedRole, "team", "create"),
		canRename: membershipHolds(storedRole, "team", "update"),
		canDelete: membershipHolds(storedRole, "team", "delete"),
		canEditRoster: membershipHolds(storedRole, "member", "update"),
	};
}

// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Teams page's write gate is read from `orgRoles` — the statements Better Auth's team endpoints
// check — never restated (R6 E-08). Which roles may manage teams is an open maintainer decision
// (#7050), so this file pins the DERIVATION against the live role table rather than an answer: each
// expectation is computed from `orgRoles` itself, plus the parsing rules the plugin applies.

import { describe, expect, it } from "vitest";
import {
	membershipHolds,
	NO_TEAM_WRITES,
	teamsGateForRole,
} from "@/components/settings/teams/teams-gate";
import { ORG_ROLES, orgRoles } from "@/lib/authz/org-access-control";

/** What `orgRoles` itself says one role holds — the oracle, read without this module's helper. */
function tableSays(role: (typeof ORG_ROLES)[number], resource: string, action: string): boolean {
	const statements: { readonly [resource: string]: readonly string[] | undefined } =
		orgRoles[role].statements;
	return statements[resource]?.includes(action) ?? false;
}

describe("teamsGateForRole", () => {
	it.each(ORG_ROLES)("answers %s exactly as the role table does", (role) => {
		expect(teamsGateForRole(role)).toEqual({
			canCreate: tableSays(role, "team", "create"),
			canRename: tableSays(role, "team", "update"),
			canDelete: tableSays(role, "team", "delete"),
			canEditRoster: tableSays(role, "member", "update"),
		});
	});

	it("lets the owner and admin change a roster (member:update), and not an operator or viewer", () => {
		expect(teamsGateForRole("owner").canEditRoster).toBe(true);
		expect(teamsGateForRole("admin").canEditRoster).toBe(true);
		expect(teamsGateForRole("operator").canEditRoster).toBe(false);
		expect(teamsGateForRole("viewer").canEditRoster).toBe(false);
	});

	it("gives a viewer who is not a member nothing", () => {
		expect(teamsGateForRole(null)).toEqual(NO_TEAM_WRITES);
	});
});

describe("membershipHolds parses a stored role as the plugin does", () => {
	it("grants when ANY comma-separated role holds the permission, ignoring spaces", () => {
		expect(membershipHolds("viewer, admin", "member", "update")).toBe(true);
		expect(membershipHolds("viewer,operator", "member", "update")).toBe(false);
	});

	it("grants nothing for a role the table does not define, or an empty one", () => {
		expect(membershipHolds("member", "member", "update")).toBe(false);
		expect(membershipHolds("", "member", "update")).toBe(false);
		expect(membershipHolds("toString", "member", "update")).toBe(false);
	});
});

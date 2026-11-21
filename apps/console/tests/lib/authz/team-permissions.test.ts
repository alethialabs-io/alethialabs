// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #7050 — which organization roles may create, rename and delete teams. Maintainer ruling
// (2026-11-21): owners and admins may; operators and viewers may not.
//
// The organization plugin's team endpoints ask `hasPermission({ team: [<action>] })` of the
// caller's stored role, which calls each listed role's `authorize` from `orgRoles`. So the first
// block asks `orgRoles` exactly that, and the second asks the helper the CLI team routes use.
// Expected values are written out by hand, never derived from the table under test.

import { describe, expect, it } from "vitest";
import {
	membershipMayManageTeams,
	ORG_ROLES,
	orgRoles,
	type TeamAction,
} from "@/lib/authz/org-access-control";

const TEAM_ACTIONS: readonly TeamAction[] = ["create", "update", "delete"];

/** The ruling, written out: what each role may do to teams. */
const RULING: { readonly [R in (typeof ORG_ROLES)[number]]: boolean } = {
	owner: true,
	admin: true,
	operator: false,
	viewer: false,
};

describe("orgRoles — the table the organization plugin authorizes team endpoints from", () => {
	it.each(ORG_ROLES)("%s: create, rename and delete follow the ruling", (role) => {
		const answers = TEAM_ACTIONS.map(
			(action) => orgRoles[role].authorize({ team: [action] }).success,
		);
		expect(answers).toEqual([RULING[role], RULING[role], RULING[role]]);
	});

	it("an owner or admin may do all three in one request", () => {
		expect(orgRoles.owner.authorize({ team: ["create", "update", "delete"] }).success).toBe(true);
		expect(orgRoles.admin.authorize({ team: ["create", "update", "delete"] }).success).toBe(true);
	});

	it("leaves the rest of each role as it was", () => {
		expect(orgRoles.admin.authorize({ organization: ["delete"] }).success).toBe(false);
		expect(orgRoles.admin.authorize({ member: ["update"] }).success).toBe(true);
		expect(orgRoles.operator.authorize({ member: ["update"] }).success).toBe(false);
		expect(orgRoles.viewer.authorize({ invitation: ["create"] }).success).toBe(false);
	});
});

describe("membershipMayManageTeams — a stored membership role, read as the plugin reads it", () => {
	it.each([
		["owner", true],
		["admin", true],
		["operator", false],
		["viewer", false],
	] as const)("%s → %s for every team action", (stored, allowed) => {
		const answers = TEAM_ACTIONS.map((action) => membershipMayManageTeams(stored, action));
		expect(answers).toEqual([allowed, allowed, allowed]);
	});

	it("refuses Better Auth's `member`, which the table does not define", () => {
		expect(membershipMayManageTeams("member", "create")).toBe(false);
	});

	it("allows when ANY comma-separated role holds it", () => {
		expect(membershipMayManageTeams("viewer,admin", "create")).toBe(true);
		expect(membershipMayManageTeams("viewer,operator", "create")).toBe(false);
	});

	it("does not trim, because the plugin does not", () => {
		expect(membershipMayManageTeams("viewer, admin", "delete")).toBe(false);
	});

	it("refuses an empty role and a name inherited from Object.prototype", () => {
		const refused = ["", "toString", "constructor", "__proto__"].filter((stored) =>
			membershipMayManageTeams(stored, "create"),
		);
		expect(refused).toEqual([]);
	});
});

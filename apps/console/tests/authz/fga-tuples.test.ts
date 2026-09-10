// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
	expandGrant,
	hierarchyTuple,
	orgScopeCarriesResourceId,
	teamMemberTuple,
} from "@/lib/authz/fga-tuples";
import { BUILT_IN_ROLES, PERMISSIONS } from "@/lib/authz/registry";

const ALL_KEYS: string[] = PERMISSIONS.map((p) => p.key);
const ownerKeys = ALL_KEYS; // owner = "*"
const viewer = BUILT_IN_ROLES.viewer;
const viewerKeys: string[] = viewer === "*" ? ALL_KEYS : viewer; // only :view keys

const base = { orgId: "O", principalType: "user" as const, principalId: "U" };

describe("expandGrant (role → permission tuples)", () => {
	it("org-wide allow writes one org capability per permission key", () => {
		const tuples = expandGrant(
			{ ...base, effect: "allow", resourceType: "org", resourceId: null },
			ownerKeys,
		);
		expect(tuples).toHaveLength(ownerKeys.length);
		for (const t of tuples) {
			expect(t.user).toBe("user:U");
			expect(t.object).toBe("org:O");
		}
		expect(tuples).toContainEqual({ user: "user:U", relation: "project_deploy", object: "org:O" });
		expect(tuples).toContainEqual({ user: "user:U", relation: "member_manage_members", object: "org:O" });
	});

	it("team principal uses the team#member userset", () => {
		const [t] = expandGrant(
			{ orgId: "O", principalType: "team", principalId: "T", effect: "allow", resourceType: "org", resourceId: null },
			["project:view"],
		);
		expect(t).toEqual({ user: "team:T#member", relation: "project_view", object: "org:O" });
	});

	it("project-scoped allow: project actions → perm_ on the project, no org-level, no create", () => {
		const tuples = expandGrant(
			{ ...base, effect: "allow", resourceType: "project", resourceId: "S" },
			ownerKeys,
		);
		expect(tuples).toContainEqual({ user: "user:U", relation: "perm_view", object: "project:S" });
		expect(tuples).toContainEqual({ user: "user:U", relation: "perm_deploy", object: "project:S" });
		// Projects are top-level (no descendants), so a scoped grant only writes perm_ on the project.
		expect(tuples.every((t) => t.object === "project:S")).toBe(true);
		expect(tuples.some((t) => t.relation === "member_manage_members")).toBe(false);
		// `create` is org-level and never conferred by a scoped grant.
		expect(tuples.some((t) => t.relation === "perm_create")).toBe(false);
	});

	it("leaf-scoped allow (runner) writes only perm_ on the runner", () => {
		const tuples = expandGrant(
			{ ...base, effect: "allow", resourceType: "runner", resourceId: "R" },
			ownerKeys,
		);
		expect(tuples.length).toBeGreaterThan(0);
		for (const t of tuples) {
			expect(t.object).toBe("runner:R");
			expect(t.relation.startsWith("perm_")).toBe(true);
		}
	});

	it("viewer role expands to view tuples plus own-support create/reply", () => {
		const tuples = expandGrant(
			{ ...base, effect: "allow", resourceType: "org", resourceId: null },
			viewerKeys,
		);
		expect(
			tuples.every(
				(t) =>
					t.relation.endsWith("_view") ||
					t.relation.endsWith("_view_activity") ||
					t.relation.endsWith("_view_alerts") ||
					// support is a right — viewers may open + reply to their own cases.
					t.relation === "support_case_create" ||
					t.relation === "support_case_reply",
			),
		).toBe(true);
	});

	it("a DENY grant writes deny_ relations (the exclusion)", () => {
		// deny a single permission on a specific project → perm_deny_ on that project
		const projectDeny = expandGrant(
			{ ...base, effect: "deny", resourceType: "project", resourceId: "S" },
			["project:view"],
		);
		expect(projectDeny).toContainEqual({ user: "user:U", relation: "perm_deny_view", object: "project:S" });

		// org-wide deny → the org deny capability
		const orgDeny = expandGrant(
			{ ...base, effect: "deny", resourceType: "org", resourceId: null },
			["project:view"],
		);
		expect(orgDeny).toContainEqual({ user: "user:U", relation: "project_deny_view", object: "org:O" });
	});
});

describe("hierarchy + team tuples", () => {
	it("hierarchyTuple makes the child point at its parent", () => {
		expect(hierarchyTuple({ childType: "project", childId: "S", parentType: "org", parentId: "O" })).toEqual({
			user: "org:O",
			relation: "parent",
			object: "project:S",
		});
	});
	it("teamMemberTuple links a user into a team", () => {
		expect(teamMemberTuple("T", "U")).toEqual({ user: "user:U", relation: "member", object: "team:T" });
	});
});

// The pair `GrantScope` cannot represent honestly. `"org"` is the DEFAULT resource kind at both
// write boundaries, so a caller who names a resource and forgets its kind would otherwise get an
// ORGANIZATION-WIDE grant while the call reads as scoped to one project. Both directions are
// asserted: over-refusing here would break every legitimate grant, which is the failure a
// bad-pair-only test cannot see.
describe("orgScopeCarriesResourceId (the org-kind + resource-id refusal)", () => {
	it("is true for an org kind carrying a resource id — the silent widening", () => {
		expect(orgScopeCarriesResourceId("org", "11111111-2222-3333-4444-555555555555")).toBe(true);
	});

	it("is false for a genuine org-wide grant — org kind, no id", () => {
		expect(orgScopeCarriesResourceId("org", null)).toBe(false);
	});

	it("is false for a scoped grant — a real kind carrying its own id", () => {
		for (const kind of ["project", "runner", "cloud_identity"]) {
			expect(orgScopeCarriesResourceId(kind, "11111111-2222-3333-4444-555555555555")).toBe(false);
		}
	});

	it("is false for a kind with no id — the write boundaries collapse that to org themselves", () => {
		expect(orgScopeCarriesResourceId("project", null)).toBe(false);
	});

	// Guards the reason the refusal exists rather than the refusal itself: if `expandGrant` ever
	// started honouring the id under an org kind, refusing the pair would be over-strict rather
	// than protective, and this test is what would say so.
	it("expandGrant does take org-wide for the refused pair, so the id really is dropped", () => {
		const tuples = expandGrant(
			{ ...base, effect: "allow", resourceType: "org", resourceId: "S" },
			viewerKeys,
		);
		expect(tuples.length).toBeGreaterThan(0);
		expect(tuples.every((t) => t.object === "org:O")).toBe(true);
		expect(tuples.some((t) => t.object.includes("S"))).toBe(false);
	});
});

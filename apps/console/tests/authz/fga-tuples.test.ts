// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { expandGrant, hierarchyTuple, teamMemberTuple } from "@/lib/authz/fga-tuples";
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
		expect(tuples).toContainEqual({ user: "user:U", relation: "spec_deploy", object: "org:O" });
		expect(tuples).toContainEqual({ user: "user:U", relation: "member_manage_members", object: "org:O" });
	});

	it("team principal uses the team#member userset", () => {
		const [t] = expandGrant(
			{ orgId: "O", principalType: "team", principalId: "T", effect: "allow", resourceType: "org", resourceId: null },
			["zone:view"],
		);
		expect(t).toEqual({ user: "team:T#member", relation: "zone_view", object: "org:O" });
	});

	it("zone-scoped allow: zone actions → perm_ on zone, spec actions → spec_ capability, no org-level", () => {
		const tuples = expandGrant(
			{ ...base, effect: "allow", resourceType: "zone", resourceId: "Z" },
			ownerKeys,
		);
		expect(tuples).toContainEqual({ user: "user:U", relation: "perm_view", object: "zone:Z" });
		expect(tuples).toContainEqual({ user: "user:U", relation: "spec_deploy", object: "zone:Z" });
		expect(tuples.every((t) => t.object === "zone:Z")).toBe(true);
		expect(tuples.some((t) => t.relation === "member_manage_members")).toBe(false);
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

	it("viewer role expands to view-only tuples", () => {
		const tuples = expandGrant(
			{ ...base, effect: "allow", resourceType: "org", resourceId: null },
			viewerKeys,
		);
		expect(tuples.every((t) => t.relation.endsWith("_view") || t.relation.endsWith("_view_audit"))).toBe(true);
	});

	it("a DENY grant writes deny_ relations (the exclusion)", () => {
		// deny a single permission on a specific spec → perm_deny_ on that spec
		const specDeny = expandGrant(
			{ ...base, effect: "deny", resourceType: "spec", resourceId: "S" },
			["spec:view"],
		);
		expect(specDeny).toContainEqual({ user: "user:U", relation: "perm_deny_view", object: "spec:S" });

		// deny spec:view across a whole zone → the zone's spec_deny_ capability
		const zoneDeny = expandGrant(
			{ ...base, effect: "deny", resourceType: "zone", resourceId: "Z" },
			["spec:view"],
		);
		expect(zoneDeny).toContainEqual({ user: "user:U", relation: "spec_deny_view", object: "zone:Z" });

		// org-wide deny → the org deny capability
		const orgDeny = expandGrant(
			{ ...base, effect: "deny", resourceType: "org", resourceId: null },
			["zone:view"],
		);
		expect(orgDeny).toContainEqual({ user: "user:U", relation: "zone_deny_view", object: "org:O" });
	});
});

describe("hierarchy + team tuples", () => {
	it("hierarchyTuple makes the child point at its parent", () => {
		expect(hierarchyTuple({ childType: "spec", childId: "S", parentType: "zone", parentId: "Z" })).toEqual({
			user: "zone:Z",
			relation: "parent",
			object: "spec:S",
		});
	});
	it("teamMemberTuple links a user into a team", () => {
		expect(teamMemberTuple("T", "U")).toEqual({ user: "user:U", relation: "member", object: "team:T" });
	});
});

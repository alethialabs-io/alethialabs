// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { expandGrant, hierarchyTuple, teamMemberTuple } from "@/lib/authz/fga-tuples";
import { BUILT_IN_ROLES, PERMISSIONS } from "@/lib/authz/registry";

const ALL_KEYS: string[] = PERMISSIONS.map((p) => p.key);
const ownerKeys = ALL_KEYS; // owner = "*"
const viewer = BUILT_IN_ROLES.viewer;
const viewerKeys: string[] = viewer === "*" ? ALL_KEYS : viewer; // only :view keys

describe("expandGrant (role → permission tuples)", () => {
	it("org-wide grant writes one org capability per permission key", () => {
		const tuples = expandGrant(
			{
				orgId: "O",
				principalType: "user",
				principalId: "U",
				resourceType: "org",
				resourceId: null,
			},
			ownerKeys,
		);
		expect(tuples).toHaveLength(ownerKeys.length);
		for (const t of tuples) {
			expect(t.user).toBe("user:U");
			expect(t.object).toBe("org:O");
		}
		// e.g. zone:deploy isn't a key, but spec:deploy → spec_deploy on org
		expect(tuples).toContainEqual({ user: "user:U", relation: "spec_deploy", object: "org:O" });
		expect(tuples).toContainEqual({ user: "user:U", relation: "member_manage_members", object: "org:O" });
	});

	it("team principal uses the team#member userset", () => {
		const [t] = expandGrant(
			{ orgId: "O", principalType: "team", principalId: "T", resourceType: "org", resourceId: null },
			["zone:view"],
		);
		expect(t).toEqual({ user: "team:T#member", relation: "zone_view", object: "org:O" });
	});

	it("zone-scoped grant: zone actions → perm_ on the zone, spec actions → spec_ capability, no org-level", () => {
		const tuples = expandGrant(
			{
				orgId: "O",
				principalType: "user",
				principalId: "U",
				resourceType: "zone",
				resourceId: "Z",
			},
			ownerKeys,
		);
		// zone's own actions become perm_ on zone:Z
		expect(tuples).toContainEqual({ user: "user:U", relation: "perm_view", object: "zone:Z" });
		expect(tuples).toContainEqual({ user: "user:U", relation: "perm_destroy", object: "zone:Z" });
		// spec (a descendant of zone) actions become container capabilities on zone:Z
		expect(tuples).toContainEqual({ user: "user:U", relation: "spec_deploy", object: "zone:Z" });
		// org-level / create / unrelated leaf keys are NOT conferred by a zone-scoped grant
		expect(tuples.every((t) => t.object === "zone:Z")).toBe(true);
		expect(tuples.some((t) => t.relation === "member_manage_members")).toBe(false);
		expect(tuples.some((t) => t.relation === "perm_create")).toBe(false);
		expect(tuples.some((t) => t.relation === "runner_view")).toBe(false);
	});

	it("leaf-scoped grant (runner) writes only perm_ on the runner", () => {
		const tuples = expandGrant(
			{
				orgId: "O",
				principalType: "user",
				principalId: "U",
				resourceType: "runner",
				resourceId: "R",
			},
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
			{ orgId: "O", principalType: "user", principalId: "U", resourceType: "org", resourceId: null },
			viewerKeys,
		);
		expect(tuples.every((t) => t.relation.endsWith("_view") || t.relation.endsWith("_view_audit"))).toBe(true);
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

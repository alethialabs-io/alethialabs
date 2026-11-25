// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { BUILT_IN_ROLES, isPermissionKey, PERMISSIONS } from "@/lib/authz/registry";
import { requiredScopes } from "@/lib/authz/scope-ceiling";
import { AGENT_SCOPES } from "@/lib/approvals/types";
import { toCheck } from "@/lib/authz/fga-mapping";

/** The keys a built-in role carries, with owner's "*" expanded to every permission. */
function keysOf(role: keyof typeof BUILT_IN_ROLES): string[] {
	const keys = BUILT_IN_ROLES[role];
	return keys === "*" ? PERMISSIONS.map((p) => p.key) : keys;
}

describe("org:manage_agents (AGT-L2, maintainer ruling 2026-11-24)", () => {
	it("is a real permission on the org", () => {
		expect(isPermissionKey("org:manage_agents")).toBe(true);
		expect(PERMISSIONS.find((p) => p.key === "org:manage_agents")).toMatchObject({
			resource: "org",
			action: "manage_agents",
		});
	});

	it("falls to the owner role only among the built-in roles", () => {
		expect(keysOf("owner")).toContain("org:manage_agents");
		expect(keysOf("admin")).not.toContain("org:manage_agents");
		expect(keysOf("operator")).not.toContain("org:manage_agents");
		expect(keysOf("viewer")).not.toContain("org:manage_agents");
	});

	it("leaves admin's other org permissions as they were", () => {
		const admin = keysOf("admin");
		expect(admin).toContain("org:edit");
		expect(admin).toContain("org:manage_tokens");
		expect(admin.some((k) => k.startsWith("billing:"))).toBe(false);
	});

	it("is administration: a scope-limited credential needs every scope to use it", () => {
		expect(requiredScopes("manage_agents", "org")).toEqual(AGENT_SCOPES);
	});

	it("is checked as an org capability in the ReBAC model", () => {
		expect(toCheck("org", "manage_agents", { orgId: "o-1" })).toEqual({
			object: "org:o-1",
			relation: "org_manage_agents",
		});
	});
});

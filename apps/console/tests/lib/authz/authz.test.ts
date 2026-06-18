// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { coversResource, permissionKey } from "@/lib/authz/evaluate";
import {
	BUILT_IN_ROLES,
	BUILTIN_ROLE_IDS,
	isPermissionKey,
	PERMISSIONS,
} from "@/lib/authz/registry";

const ZONE = "11111111-1111-1111-1111-111111111111";
const SPEC = "22222222-2222-2222-2222-222222222222";
const OTHER = "33333333-3333-3333-3333-333333333333";

describe("permissionKey", () => {
	it("joins resource and action", () => {
		expect(permissionKey("spec", "deploy")).toBe("spec:deploy");
		expect(permissionKey("zone", "view")).toBe("zone:view");
	});
});

describe("coversResource", () => {
	it("default-denies with no matching grants", () => {
		expect(coversResource([], SPEC, [])).toBe(false);
	});

	it("allows an org-wide grant (null resource_id) regardless of target", () => {
		expect(coversResource([null], SPEC, [])).toBe(true);
		expect(coversResource([null], undefined, [])).toBe(true);
		expect(coversResource([OTHER, null], SPEC, [])).toBe(true);
	});

	it("allows an exact resource-scoped grant", () => {
		expect(coversResource([SPEC], SPEC, [])).toBe(true);
	});

	it("allows via hierarchy inheritance (zone grant ⇒ child spec)", () => {
		// Grant is on the parent zone; the target spec lists the zone as an ancestor.
		expect(coversResource([ZONE], SPEC, [ZONE])).toBe(true);
	});

	it("denies when the grant scope is unrelated to the target or its ancestors", () => {
		expect(coversResource([OTHER], SPEC, [ZONE])).toBe(false);
	});

	it("denies a scoped grant when there is no concrete target", () => {
		expect(coversResource([ZONE], undefined, [ZONE])).toBe(false);
	});
});

describe("built-in role templates", () => {
	it("owner is the wildcard", () => {
		expect(BUILT_IN_ROLES.owner).toBe("*");
	});

	it("every non-wildcard role references only real permission keys", () => {
		for (const [name, keys] of Object.entries(BUILT_IN_ROLES)) {
			if (keys === "*") continue;
			for (const key of keys) {
				expect(isPermissionKey(key), `${name} → ${key}`).toBe(true);
			}
		}
	});

	it("admin has everything except billing", () => {
		const admin = BUILT_IN_ROLES.admin;
		if (admin === "*") throw new Error("admin should be an explicit set");
		expect(admin.some((k) => k.startsWith("billing:"))).toBe(false);
		expect(admin).toContain("spec:deploy");
	});

	it("operator excludes identities/members/billing/audit", () => {
		const operator = BUILT_IN_ROLES.operator;
		if (operator === "*") throw new Error("operator should be an explicit set");
		for (const blocked of ["cloud_identity:", "member:", "billing:", "audit:"]) {
			expect(operator.some((k) => k.startsWith(blocked))).toBe(false);
		}
		expect(operator).toContain("spec:deploy");
	});

	it("viewer is read-only", () => {
		const viewer = BUILT_IN_ROLES.viewer;
		if (viewer === "*") throw new Error("viewer should be an explicit set");
		expect(viewer.every((k) => k.endsWith(":view"))).toBe(true);
	});

	it("has a stable UUID per built-in role", () => {
		const ids = Object.values(BUILTIN_ROLE_IDS);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe("permission registry", () => {
	it("has unique keys", () => {
		const keys = PERMISSIONS.map((p) => p.key);
		expect(new Set(keys).size).toBe(keys.length);
	});
});

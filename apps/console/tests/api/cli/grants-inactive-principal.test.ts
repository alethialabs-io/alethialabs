// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// POST /api/cli/grants refuses an ALLOW grant to a user who is not an active member of the org
// (#5472): a suspended member, and a user with no member row at all. The member lifecycle
// (`ensureMemberGrant`) refuses a suspended member since #5465; before this, the CLI grant API
// inserted an org-wide allow grant for one and answered 201, and an allow grant for a user with no
// member row was inserted too, to go live if they later joined.

import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ db: {} }));

vi.mock("@/lib/authz/guard", () => ({
	authorizeCli: async () => ({ actor: { userId: "user-1", orgId: "org-1" } }),
}));
vi.mock("@/lib/authz/entitlements", () => ({ getEntitlements: () => ({ customRoles: true }) }));
vi.mock("@/lib/authz", () => ({ getPdp: () => ({ can: async () => ({ allowed: true }) }) }));
vi.mock("@/lib/authz/role-permissions", () => ({ rolePermissionKeys: async () => [] }));
vi.mock("@/lib/authz/tuple-sync", () => ({
	getTupleSync: () => ({ syncScopedGrant: async () => undefined }),
}));
vi.mock("@/lib/authz/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/alerts/emit", () => ({ emitAlertEventSafe: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb: () => h.db }));

import { POST } from "@/app/api/cli/grants/route";

const PRINCIPAL = "11111111-1111-4111-8111-111111111111";
const ROLE = "44444444-4444-4444-8444-444444444444";

/**
 * A drizzle-ish chain. A `select` resolves to the principal's member rows (`memberRows`); an
 * `insert` resolves to the created grant row and is recorded in `insertSpy`.
 */
function makeDb(memberRows: { status: string }[]) {
	const insertSpy = vi.fn();
	function chain(result: unknown[]) {
		const c: Record<string, unknown> = {};
		for (const m of ["from", "leftJoin", "where", "orderBy", "limit", "values", "returning"]) {
			c[m] = () => c;
		}
		c.then = (resolve: (v: unknown) => void) => resolve(result);
		return c;
	}
	const created = {
		id: "33333333-3333-4333-8333-333333333333",
		principal_type: "user",
		principal_id: PRINCIPAL,
		effect: "allow",
		role_id: null,
		permission_key: "project:view",
		resource_type: "org",
		resource_id: null,
	};
	const db = {
		select: () => chain(memberRows),
		insert: () => {
			insertSpy();
			return chain([created]);
		},
	};
	h.db = db;
	return { insertSpy };
}

/** The request `alethia grants add` sends. */
function req(body: Record<string, unknown>): Request {
	return new Request("https://console.local/api/cli/grants", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("POST /api/cli/grants — a member who is not active (#5472)", () => {
	it("answers 400 to an ALLOW grant for a suspended member and inserts nothing; a deny, and an active member's allow, are created", async () => {
		const suspended = makeDb([{ status: "suspended" }]);
		const res = await POST(
			req({ principal_type: "user", principal_id: PRINCIPAL, effect: "allow", role_id: ROLE }),
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			error: "That user is not an active member of this organization. Grant access only to active members.",
		});
		expect(suspended.insertSpy).not.toHaveBeenCalled();

		// The controls: a deny only removes access, so it is created for the suspended member, and an
		// active member's allow grant is created.
		const deny = await POST(
			req({
				principal_type: "user",
				principal_id: PRINCIPAL,
				effect: "deny",
				permission_key: "project:view",
			}),
		);
		expect(deny.status).toBe(201);
		expect(suspended.insertSpy).toHaveBeenCalledTimes(1);

		const active = makeDb([{ status: "active" }]);
		const ok = await POST(
			req({
				principal_type: "user",
				principal_id: PRINCIPAL,
				effect: "allow",
				permission_key: "project:view",
			}),
		);
		expect(ok.status).toBe(201);
		expect(active.insertSpy).toHaveBeenCalledTimes(1);
	});

	it("answers 400 to an ALLOW grant, org-wide or scoped, for a user with NO member row and inserts nothing; a deny for them is created", async () => {
		const none = makeDb([]);
		const orgWide = await POST(
			req({ principal_type: "user", principal_id: PRINCIPAL, effect: "allow", role_id: ROLE }),
		);
		expect(orgWide.status).toBe(400);
		const scoped = await POST(
			req({
				principal_type: "user",
				principal_id: PRINCIPAL,
				effect: "allow",
				permission_key: "project:view",
				resource_type: "project",
				resource_id: "22222222-2222-4222-8222-222222222222",
			}),
		);
		expect(scoped.status).toBe(400);
		expect(await scoped.json()).toEqual({
			error: "That user is not an active member of this organization. Grant access only to active members.",
		});
		expect(none.insertSpy).not.toHaveBeenCalled();

		const deny = await POST(
			req({
				principal_type: "user",
				principal_id: PRINCIPAL,
				effect: "deny",
				permission_key: "project:view",
			}),
		);
		expect(deny.status).toBe(201);
		expect(none.insertSpy).toHaveBeenCalledTimes(1);
	});
});

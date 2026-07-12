// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the access-grants actions: stub currentActor, a thenable
// drizzle chain (table-aware so the four getGrantOptions selects resolve to distinct rows),
// the tuple-sync seam, the alert/activity emitters, and the members/roles sibling actions.
// The permission registry + entitlement math stay real, so we assert the Enterprise gate,
// the role-xor-permission validation, the org/resource_type derivation, and the row mapping.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ authorize: vi.fn() }));
vi.mock("@/lib/authz", () => ({ getPdp: vi.fn() }));
vi.mock("@/lib/authz/role-permissions", () => ({ rolePermissionKeys: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/app/server/actions/members", () => ({ getMembers: vi.fn() }));
vi.mock("@/app/server/actions/roles", () => ({ listCustomRoles: vi.fn() }));
vi.mock("@/lib/authz/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/alerts/emit", () => ({ emitAlertEventSafe: vi.fn() }));
vi.mock("@/lib/authz/tuple-sync", () => ({ getTupleSync: vi.fn() }));

import {
	assignGrant,
	getGrantOptions,
	listAccessGrants,
	revokeGrant,
} from "@/app/server/actions/grants";
import { getMembers } from "@/app/server/actions/members";
import { listCustomRoles } from "@/app/server/actions/roles";
import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { getPdp } from "@/lib/authz";
import { recordActivity } from "@/lib/authz/activity";
import { authorize } from "@/lib/authz/guard";
import { BUILTIN_ROLE_IDS } from "@/lib/authz/registry";
import { rolePermissionKeys } from "@/lib/authz/role-permissions";
import { ForbiddenError } from "@/lib/authz/types";
import { getTupleSync } from "@/lib/authz/tuple-sync";
import { getServiceDb } from "@/lib/db";
import {
	cloudIdentities,
	projects,
	runners,
	team,
} from "@/lib/db/schema";

/**
 * A drizzle-ish chain: every builder returns the chain; `.then` resolves to the rows
 * registered for the most-recently-`from()`'d table (falling back to `rows`). Also records
 * the `.insert/.values/.delete` writes so we can assert what was persisted.
 */
function mockDb(rows: unknown[] = [], byTable?: Map<unknown, unknown[]>) {
	const valuesSpy = vi.fn();
	const insertSpy = vi.fn();
	const deleteSpy = vi.fn();

	// Each select/insert/delete returns its OWN chain so the concurrent selects in
	// getGrantOptions (Promise.all) don't clobber a shared `from` reference.
	function makeChain() {
		let fromT: unknown;
		const c: Record<string, unknown> = {};
		Object.assign(c, {
			from: (t: unknown) => {
				fromT = t;
				return c;
			},
			leftJoin: () => c,
			innerJoin: () => c,
			where: () => c,
			limit: () => c,
			orderBy: () => c,
			values: (...a: unknown[]) => {
				valuesSpy(...a);
				return c;
			},
			then: (resolve: (v: unknown) => void) =>
				resolve(byTable?.get(fromT) ?? rows),
		});
		return c;
	}

	const db: Record<string, unknown> = {
		select: () => makeChain(),
		insert: () => {
			insertSpy();
			return makeChain();
		},
		delete: () => {
			deleteSpy();
			return makeChain();
		},
	};
	vi.mocked(getServiceDb).mockReturnValue(db as never);
	return { valuesSpy, insertSpy, deleteSpy };
}

const syncScopedGrant = vi.fn().mockResolvedValue(undefined);
const removeScopedGrant = vi.fn().mockResolvedValue(undefined);
// The privilege-ceiling PDP probe; defaults to "actor holds everything" (owner) so the persistence
// paths run — the dedicated ceiling suite flips it to a deny to prove the check is load-bearing.
const can = vi.fn().mockResolvedValue({ allowed: true });

/** An actor that passes the Enterprise (customRoles) entitlement gate. */
const ADMIN_ACTOR = {
	orgId: "org-1",
	userId: "user-1",
	entitlements: { customRoles: true },
};

beforeEach(() => {
	vi.clearAllMocks();
	syncScopedGrant.mockResolvedValue(undefined);
	removeScopedGrant.mockResolvedValue(undefined);
	can.mockResolvedValue({ allowed: true });
	vi.mocked(getPdp).mockReturnValue({ can } as never);
	vi.mocked(rolePermissionKeys).mockResolvedValue([]);
	vi.mocked(getTupleSync).mockReturnValue({
		syncScopedGrant,
		removeScopedGrant,
	} as never);
	// The real `authorize` runs the PDP; here it is mocked to resolve to an authorized
	// actor so the entitlement/validation/persistence paths below are exercised. The
	// dedicated "PDP gate" suite below instead makes it THROW, proving the gate is
	// load-bearing (a mocked rubber-stamp would otherwise hide the escalation bug).
	vi.mocked(authorize).mockResolvedValue(ADMIN_ACTOR as never);
});

describe("PDP gate (authorize) — denied actor is blocked before any DB write", () => {
	// A viewer holds `member:view` but NOT `member:manage_members`, so the real PDP
	// denies the mutating actions; here we simulate that by making `authorize` throw.
	const deny = () =>
		vi
			.mocked(authorize)
			.mockRejectedValue(
				new ForbiddenError("manage_members", { type: "member" }, "no_grant"),
			);

	it("assignGrant rejects (ForbiddenError) and never inserts", async () => {
		const { insertSpy } = mockDb();
		deny();
		await expect(
			assignGrant({
				principalType: "user",
				principalId: "u-1",
				effect: "allow",
				roleId: BUILTIN_ROLE_IDS.owner,
				resourceType: "org",
			}),
		).rejects.toThrow(ForbiddenError);
		expect(insertSpy).not.toHaveBeenCalled();
		expect(syncScopedGrant).not.toHaveBeenCalled();
		expect(emitAlertEventSafe).not.toHaveBeenCalled();
	});

	it("revokeGrant rejects (ForbiddenError) and never deletes", async () => {
		const { deleteSpy } = mockDb([
			{
				id: "g-1",
				org_id: "org-1",
				principal_type: "user",
				principal_id: "u-1",
				effect: "allow",
				role_id: BUILTIN_ROLE_IDS.owner,
				permission_key: null,
				resource_type: "org",
				resource_id: null,
			},
		]);
		deny();
		await expect(revokeGrant("g-1")).rejects.toThrow(ForbiddenError);
		expect(deleteSpy).not.toHaveBeenCalled();
		expect(removeScopedGrant).not.toHaveBeenCalled();
	});

	it("listAccessGrants rejects (ForbiddenError) before querying", async () => {
		mockDb();
		vi
			.mocked(authorize)
			.mockRejectedValue(
				new ForbiddenError("view", { type: "member" }, "no_grant"),
			);
		await expect(listAccessGrants()).rejects.toThrow(ForbiddenError);
	});

	it("getGrantOptions rejects (ForbiddenError) before querying", async () => {
		mockDb();
		vi
			.mocked(authorize)
			.mockRejectedValue(
				new ForbiddenError("view", { type: "member" }, "no_grant"),
			);
		await expect(getGrantOptions()).rejects.toThrow(ForbiddenError);
	});
});

describe("privilege ceiling — a grant above the actor's own permissions is blocked", () => {
	// The actor passes requireAccessAdmin (member:manage_members), but the PDP reports they do NOT
	// hold the permission being granted (e.g. an admin granting billing) → ForbiddenError, no insert.
	// The real-PDP proof is tests/integration/grants-actions-authz.test.ts.
	it("assignGrant rejects a single permission the actor lacks and never inserts", async () => {
		const { insertSpy } = mockDb();
		can.mockResolvedValue({ allowed: false, reason: "no_grant" });
		await expect(
			assignGrant({
				principalType: "user",
				principalId: "u-1",
				effect: "allow",
				permissionKey: "billing:manage_billing",
				resourceType: "org",
			}),
		).rejects.toThrow(ForbiddenError);
		expect(insertSpy).not.toHaveBeenCalled();
		expect(syncScopedGrant).not.toHaveBeenCalled();
	});

	it("assignGrant rejects a role carrying a permission the actor lacks", async () => {
		const { insertSpy } = mockDb();
		vi.mocked(rolePermissionKeys).mockResolvedValue(["billing:manage_billing"]);
		can.mockResolvedValue({ allowed: false, reason: "no_grant" });
		await expect(
			assignGrant({
				principalType: "user",
				principalId: "u-1",
				effect: "allow",
				roleId: BUILTIN_ROLE_IDS.owner,
				resourceType: "org",
			}),
		).rejects.toThrow(ForbiddenError);
		expect(insertSpy).not.toHaveBeenCalled();
	});

	it("a DENY grant skips the ceiling (a deny can't escalate the grantee)", async () => {
		const { insertSpy } = mockDb();
		can.mockResolvedValue({ allowed: false, reason: "no_grant" }); // would block an allow …
		await assignGrant({
			principalType: "user",
			principalId: "u-1",
			effect: "deny", // … but a deny is never ceiling-checked
			permissionKey: "billing:manage_billing",
			resourceType: "org",
		});
		expect(insertSpy).toHaveBeenCalledTimes(1);
		expect(can).not.toHaveBeenCalled();
	});
});

describe("requireAccessAdmin gate", () => {
	it("assignGrant rejects an actor without the customRoles entitlement", async () => {
		vi.mocked(authorize).mockResolvedValue({
			orgId: "org-1",
			userId: "user-1",
			entitlements: undefined,
		} as never);
		await expect(
			assignGrant({
				principalType: "user",
				principalId: "u-9",
				effect: "allow",
				permissionKey: "project:view",
				resourceType: "project",
			}),
		).rejects.toThrow(/Enterprise license/);
	});

	it("revokeGrant rejects an actor without the customRoles entitlement", async () => {
		vi.mocked(authorize).mockResolvedValue({
			orgId: "org-1",
			userId: "user-1",
			entitlements: { customRoles: false },
		} as never);
		await expect(revokeGrant("g-1")).rejects.toThrow(/Enterprise license/);
	});
});

describe("assignGrant validation", () => {
	it("rejects when both a role and a permission are provided", async () => {
		mockDb();
		await expect(
			assignGrant({
				principalType: "user",
				principalId: "u-1",
				effect: "allow",
				roleId: "r-1",
				permissionKey: "project:view",
				resourceType: "project",
			}),
		).rejects.toThrow(/exactly one/);
	});

	it("rejects when neither a role nor a permission is provided", async () => {
		mockDb();
		await expect(
			assignGrant({
				principalType: "user",
				principalId: "u-1",
				effect: "allow",
				resourceType: "project",
			}),
		).rejects.toThrow(/exactly one/);
	});

	it("rejects an unknown permission key", async () => {
		mockDb();
		await expect(
			assignGrant({
				principalType: "user",
				principalId: "u-1",
				effect: "allow",
				permissionKey: "project:nuke",
				resourceType: "project",
			}),
		).rejects.toThrow(/Unknown permission/);
	});
});

describe("assignGrant persistence", () => {
	it("stores an org-wide grant (resource_type=org) when no resourceId is given, and fires the side effects", async () => {
		const { valuesSpy, insertSpy } = mockDb();
		await assignGrant({
			principalType: "user",
			principalId: "u-1",
			effect: "allow",
			permissionKey: "project:view",
			resourceType: "project",
		});

		expect(insertSpy).toHaveBeenCalledTimes(1);
		expect(valuesSpy).toHaveBeenCalledWith({
			org_id: "org-1",
			principal_type: "user",
			principal_id: "u-1",
			effect: "allow",
			role_id: null,
			permission_key: "project:view",
			resource_type: "org", // collapsed because resourceId is null
			resource_id: null,
		});

		// tuple sync mirrors the same collapsed resource_type
		expect(syncScopedGrant).toHaveBeenCalledWith(
			expect.objectContaining({
				orgId: "org-1",
				principalId: "u-1",
				resourceType: "org",
				resourceId: null,
				permissionKey: "project:view",
				roleId: null,
			}),
		);
		expect(emitAlertEventSafe).toHaveBeenCalledWith(
			"org-1",
			"authz.grant.assign",
			expect.objectContaining({ action: "assign", actor_id: "user-1" }),
		);
		expect(recordActivity).toHaveBeenCalledWith(ADMIN_ACTOR, "assign", {
			type: "grant",
		});
	});

	it("keeps the given resource_type when a resourceId is present, and supports a role grant", async () => {
		const { valuesSpy } = mockDb();
		await assignGrant({
			principalType: "team",
			principalId: "t-1",
			effect: "deny",
			roleId: "role-9",
			resourceType: "runner",
			resourceId: "runner-7",
		});

		expect(valuesSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				principal_type: "team",
				principal_id: "t-1",
				effect: "deny",
				role_id: "role-9",
				permission_key: null,
				resource_type: "runner", // preserved because a resourceId is set
				resource_id: "runner-7",
			}),
		);
		expect(syncScopedGrant).toHaveBeenCalledWith(
			expect.objectContaining({
				resourceType: "runner",
				resourceId: "runner-7",
				roleId: "role-9",
				permissionKey: null,
			}),
		);
	});

	it("swallows a tuple-sync failure without rejecting the action", async () => {
		mockDb();
		syncScopedGrant.mockRejectedValueOnce(new Error("fga down"));
		await expect(
			assignGrant({
				principalType: "user",
				principalId: "u-1",
				effect: "allow",
				permissionKey: "project:view",
				resourceType: "project",
			}),
		).resolves.toBeUndefined();
	});
});

describe("revokeGrant", () => {
	it("no-ops (no delete / no tuple removal) when the grant is not found", async () => {
		const { deleteSpy } = mockDb([]); // select().limit(1) → []
		await revokeGrant("missing");
		expect(deleteSpy).not.toHaveBeenCalled();
		expect(removeScopedGrant).not.toHaveBeenCalled();
		expect(emitAlertEventSafe).not.toHaveBeenCalled();
	});

	it("deletes the grant, removes the tuple, and emits when found", async () => {
		const { deleteSpy } = mockDb([
			{
				id: "g-1",
				org_id: "org-1",
				principal_type: "team",
				principal_id: "t-1",
				effect: "deny",
				role_id: null,
				permission_key: "runner:deploy",
				resource_type: "runner",
				resource_id: "runner-7",
			},
		]);
		await revokeGrant("g-1");

		expect(deleteSpy).toHaveBeenCalledTimes(1);
		expect(removeScopedGrant).toHaveBeenCalledWith(
			expect.objectContaining({
				orgId: "org-1",
				principalType: "team",
				principalId: "t-1",
				effect: "deny",
				resourceType: "runner",
				resourceId: "runner-7",
				permissionKey: "runner:deploy",
			}),
		);
		expect(emitAlertEventSafe).toHaveBeenCalledWith(
			"org-1",
			"authz.grant.revoke",
			expect.objectContaining({ action: "revoke", actor_id: "user-1" }),
		);
		expect(recordActivity).toHaveBeenCalledWith(ADMIN_ACTOR, "revoke", {
			type: "grant",
		});
	});

	it("normalizes a non-team principal to user and a non-deny effect to allow for the tuple removal", async () => {
		mockDb([
			{
				id: "g-2",
				org_id: "org-1",
				principal_type: "user",
				principal_id: "u-5",
				effect: "allow",
				role_id: "role-3",
				permission_key: null,
				resource_type: "org",
				resource_id: null,
			},
		]);
		await revokeGrant("g-2");
		expect(removeScopedGrant).toHaveBeenCalledWith(
			expect.objectContaining({
				principalType: "user",
				effect: "allow",
				roleId: "role-3",
				resourceType: "org",
				resourceId: null,
			}),
		);
	});
});

describe("getGrantOptions", () => {
	it("assembles principals (members+teams), roles (builtin+custom), permissions, and resources", async () => {
		vi.mocked(getMembers).mockResolvedValue([
			{ userId: "u-1", name: "Alice", email: "a@x.io" },
			{ userId: "u-2", name: null, email: "b@x.io" },
		] as never);
		vi.mocked(listCustomRoles).mockResolvedValue([
			{ id: "cr-1", name: "Auditor" },
		] as never);

		mockDb(
			[],
			new Map<unknown, unknown[]>([
				[team, [{ id: "t-1", label: "Platform" }]],
				[projects, [{ id: "p-1", label: "prod" }]],
				[runners, [{ id: "rn-1", label: "fleet-a" }]],
				[cloudIdentities, [{ id: "ci-1", label: "aws-main" }]],
			]),
		);

		const opts = await getGrantOptions();

		// members fall back to email when name is null; teams appended as principals
		expect(opts.principals).toEqual([
			{ id: "u-1", label: "Alice", type: "user" },
			{ id: "u-2", label: "b@x.io", type: "user" },
			{ id: "t-1", label: "Platform", type: "team" },
		]);

		// four built-in roles, with the custom role appended last
		const builtin = opts.roles.filter((r) => r.builtin);
		expect(builtin).toHaveLength(4);
		expect(builtin.find((r) => r.name === "owner")?.id).toBe(
			BUILTIN_ROLE_IDS.owner,
		);
		expect(opts.roles.at(-1)).toEqual({
			id: "cr-1",
			name: "Auditor",
			builtin: false,
		});

		// real permission registry flows through
		expect(opts.permissions).toContainEqual({
			key: "project:view",
			resource: "project",
			action: "view",
		});

		// resources keyed by type from the table-specific selects
		expect(opts.resources).toEqual({
			project: [{ id: "p-1", label: "prod" }],
			runner: [{ id: "rn-1", label: "fleet-a" }],
			cloud_identity: [{ id: "ci-1", label: "aws-main" }],
		});
	});
});

describe("listAccessGrants", () => {
	it("maps rows, labels the principal, normalizes the effect, and ISO-formats createdAt", async () => {
		const created = new Date("2026-01-02T03:04:05.000Z");
		mockDb([
			{
				id: "g-1",
				principalType: "user",
				principalId: "u-1",
				principalName: "Alice",
				principalEmail: "a@x.io",
				effect: "allow",
				roleName: "admin",
				permissionKey: null,
				resourceType: "org",
				resourceId: null,
				createdAt: created,
			},
			{
				id: "g-2",
				principalType: "team",
				principalId: "team-abcdef1234",
				principalName: null,
				principalEmail: null,
				effect: "weird", // not "deny" → normalized to "allow"
				roleName: null,
				permissionKey: "runner:deploy",
				resourceType: "runner",
				resourceId: "runner-7",
				createdAt: created,
			},
		]);

		const rows = await listAccessGrants();

		expect(rows[0]).toEqual({
			id: "g-1",
			principalType: "user",
			principalId: "u-1",
			principalLabel: "Alice", // name preferred
			effect: "allow",
			roleName: "admin",
			permissionKey: null,
			resourceType: "org",
			resourceId: null,
			createdAt: "2026-01-02T03:04:05.000Z",
		});
		// no name/email → first 8 chars + ellipsis; unknown effect collapses to allow
		expect(rows[1].principalLabel).toBe("team-abc…");
		expect(rows[1].effect).toBe("allow");
		expect(rows[1].permissionKey).toBe("runner:deploy");
	});
});

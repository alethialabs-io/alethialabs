// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the access-grants actions: stub the guard, a thenable drizzle chain,
// the tuple-sync seam and the alert/activity emitters. The permission registry + entitlement math
// stay real, so we assert the Enterprise gate, the role-xor-permission validation, the
// org/resource_type derivation, and the row mapping. Since #6129 `assignGrant` and `revokeGrant` are
// `defineAction`s: every refusal is asserted as the typed `ActionResult` the client receives. The
// builder's options read moved to lib/rpc/procedures/members.ts (tests/lib/rpc/members-procedures.test.ts).

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ authorize: vi.fn() }));
vi.mock("@/lib/authz", () => ({ getPdp: vi.fn() }));
vi.mock("@/lib/authz/role-permissions", () => ({ rolePermissionKeys: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/authz/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/alerts/emit", () => ({ emitAlertEventSafe: vi.fn() }));
vi.mock("@/lib/authz/tuple-sync", () => ({ getTupleSync: vi.fn() }));
// The org-binding check asks Postgres (lib/authz/grant-binding.ts); here every grant is bound
// unless a case says otherwise. The refusals themselves run against real Postgres in
// tests/integration/grant-org-binding.test.ts.
vi.mock("@/lib/authz/grant-binding", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/authz/grant-binding")>()),
	grantBindingViolation: vi.fn(async () => null),
}));

import {
	assignGrant,
	listAccessGrants,
	revokeGrant,
} from "@/app/server/actions/grants";
import type { ActionResult } from "@/lib/actions/result";
import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { getPdp } from "@/lib/authz";
import { recordActivity } from "@/lib/authz/activity";
import { authorize } from "@/lib/authz/guard";
import { INSTANCE_TYPES } from "@/lib/authz/fga-hierarchy";
import { EMPTY_RESOURCE_ID } from "@/lib/authz/fga-tuples";
import { BUILTIN_ROLE_IDS } from "@/lib/authz/registry";
import { rolePermissionKeys } from "@/lib/authz/role-permissions";
import { ForbiddenError } from "@/lib/authz/types";
import { getTupleSync } from "@/lib/authz/tuple-sync";
import { type GrantBindingReason, grantBindingViolation } from "@/lib/authz/grant-binding";
import { getServiceDb } from "@/lib/db";
import {
	GRANT_RESOURCE_TYPES,
	UNKNOWN_RESOURCE_TYPE,
} from "@/lib/validations/grants";
import { member } from "@/lib/db/schema";

/** Grant ids as `revokeGrant` now requires them: uuids. */
const G1 = "00000000-0000-4000-8000-0000000000c1";
const G2 = "00000000-0000-4000-8000-0000000000c2";
const G3 = "00000000-0000-4000-8000-0000000000c3";
const G4 = "00000000-0000-4000-8000-0000000000c4";
const MISSING = "00000000-0000-4000-8000-0000000000cf";

/**
 * What an action's refusal says: its kind, and the sentence it shows the user (empty for a kind that
 * carries none). Null when the action SUCCEEDED, so an assertion on it cannot pass on a success.
 */
function refusal(result: ActionResult<unknown>): { kind: string; message: string } | null {
	if (result.ok) return null;
	return { kind: result.error.kind, message: "message" in result.error ? result.error.message : "" };
}

/** The member row of an active member, the principal every allow-grant case assumes. */
const ACTIVE_MEMBER = [{ status: "active" }];

/**
 * A drizzle-ish chain: every builder returns the chain; `.then` resolves to the rows
 * registered for the most-recently-`from()`'d table (falling back to `rows`). Also records
 * the `.insert/.values/.delete` writes so we can assert what was persisted. The `member` table
 * resolves to an ACTIVE member row unless `byTable` names it, because `assignGrant` refuses an
 * allow grant to a user principal without one (#5472).
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
				resolve(byTable?.get(fromT) ?? (fromT === member ? ACTIVE_MEMBER : rows)),
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
	credential: "session",
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

	it("assignGrant answers forbidden and never inserts", async () => {
		const { insertSpy } = mockDb();
		deny();
		expect(refusal(await assignGrant({
				principalType: "user",
				principalId: "u-1",
				effect: "allow",
				roleId: BUILTIN_ROLE_IDS.owner,
				resourceType: "org",
			}))?.kind).toBe("forbidden");
		expect(insertSpy).not.toHaveBeenCalled();
		expect(syncScopedGrant).not.toHaveBeenCalled();
		expect(emitAlertEventSafe).not.toHaveBeenCalled();
	});

	it("revokeGrant answers forbidden and never deletes", async () => {
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
		expect(refusal(await revokeGrant({ id: G1 }))?.kind).toBe("forbidden");
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

});

describe("privilege ceiling — a grant above the actor's own permissions is blocked", () => {
	// The actor passes requireAccessAdmin (member:manage_members), but the PDP reports they do NOT
	// hold the permission being granted (e.g. an admin granting billing) → ForbiddenError, no insert.
	// The real-PDP proof is tests/integration/grants-actions-authz.test.ts.
	it("assignGrant rejects a single permission the actor lacks and never inserts", async () => {
		const { insertSpy } = mockDb();
		can.mockResolvedValue({ allowed: false, reason: "no_grant" });
		expect(refusal(await assignGrant({
				principalType: "user",
				principalId: "u-1",
				effect: "allow",
				permissionKey: "billing:manage_billing",
				resourceType: "org",
			}))?.kind).toBe("forbidden");
		expect(insertSpy).not.toHaveBeenCalled();
		expect(syncScopedGrant).not.toHaveBeenCalled();
	});

	it("assignGrant rejects a role carrying a permission the actor lacks", async () => {
		const { insertSpy } = mockDb();
		vi.mocked(rolePermissionKeys).mockResolvedValue(["billing:manage_billing"]);
		can.mockResolvedValue({ allowed: false, reason: "no_grant" });
		expect(refusal(await assignGrant({
				principalType: "user",
				principalId: "u-1",
				effect: "allow",
				roleId: BUILTIN_ROLE_IDS.owner,
				resourceType: "org",
			}))?.kind).toBe("forbidden");
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

describe("a member who is not active gets no allow grant (#5472)", () => {
	// `ensureMemberGrant` refuses a suspended member; before #5472 this API was the way around it.
	it("assignGrant refuses an ALLOW grant to a suspended member and never inserts; a deny and an active member still go through", async () => {
		const suspended = mockDb([], new Map([[member, [{ status: "suspended" }]]]));
		expect(refusal(await assignGrant({
				principalType: "user",
				principalId: "u-1",
				effect: "allow",
				roleId: BUILTIN_ROLE_IDS.admin,
				resourceType: "org",
			}))?.message).toMatch(/not an active member/);
		expect(suspended.insertSpy).not.toHaveBeenCalled();
		expect(syncScopedGrant).not.toHaveBeenCalled();

		// A deny only removes access, so it is not refused.
		await assignGrant({
			principalType: "user",
			principalId: "u-1",
			effect: "deny",
			permissionKey: "project:view",
			resourceType: "org",
		});
		expect(suspended.insertSpy).toHaveBeenCalledTimes(1);

		const active = mockDb([], new Map([[member, [{ status: "active" }]]]));
		await assignGrant({
			principalType: "user",
			principalId: "u-1",
			effect: "allow",
			roleId: BUILTIN_ROLE_IDS.admin,
			resourceType: "org",
		});
		expect(active.insertSpy).toHaveBeenCalledTimes(1);
	});
});

describe("a user with NO member row gets no allow grant (#5472)", () => {
	// A grant planted for a non-member would go live the moment they joined the org.
	it("assignGrant refuses an org-wide or scoped ALLOW grant to a user with no member row and never inserts; a deny still goes through", async () => {
		const none = mockDb([], new Map([[member, []]]));
		expect(refusal(await assignGrant({
				principalType: "user",
				principalId: "u-1",
				effect: "allow",
				roleId: BUILTIN_ROLE_IDS.admin,
				resourceType: "org",
			}))?.message).toMatch(/not an active member/);
		expect(refusal(await assignGrant({
				principalType: "user",
				principalId: "u-1",
				effect: "allow",
				permissionKey: "project:view",
				resourceType: "project",
				resourceId: "p-1",
			}))?.message).toMatch(/not an active member/);
		expect(none.insertSpy).not.toHaveBeenCalled();
		expect(syncScopedGrant).not.toHaveBeenCalled();

		await assignGrant({
			principalType: "user",
			principalId: "u-1",
			effect: "deny",
			permissionKey: "project:view",
			resourceType: "org",
		});
		expect(none.insertSpy).toHaveBeenCalledTimes(1);
	});

	it("assignGrant refuses a request with no effect or an unknown principal type, so neither the ceiling nor the member check can be skipped", async () => {
		const none = mockDb([], new Map([[member, []]]));
		const noEffect = {
			principalType: "user",
			principalId: "u-1",
			roleId: BUILTIN_ROLE_IDS.owner,
			resourceType: "org",
		};
		// A server action's argument is a claim the compiler cannot keep: the wire carries whatever
		// the request says, which is exactly what this sends.
		// @ts-expect-error — no `effect`, as a hand-built request may omit it
		expect(refusal(await assignGrant(noEffect))?.kind).toBe("validation");
		const oddPrincipal = {
			principalType: "service",
			principalId: "u-1",
			effect: "allow",
			roleId: BUILTIN_ROLE_IDS.owner,
			resourceType: "org",
		};
		// @ts-expect-error — a principal type the schema does not name
		expect(refusal(await assignGrant(oddPrincipal))?.kind).toBe("validation");
		expect(none.insertSpy).not.toHaveBeenCalled();
	});
});

describe("requireAccessAdmin gate", () => {
	it("assignGrant rejects an actor without the customRoles entitlement", async () => {
		vi.mocked(authorize).mockResolvedValue({
			orgId: "org-1",
			userId: "user-1",
			entitlements: undefined,
		} as never);
		expect(refusal(await assignGrant({
				principalType: "user",
				principalId: "u-9",
				effect: "allow",
				permissionKey: "project:view",
				resourceType: "project",
			}))?.kind).toBe("entitlement");
	});

	it("revokeGrant rejects an actor without the customRoles entitlement", async () => {
		vi.mocked(authorize).mockResolvedValue({
			orgId: "org-1",
			userId: "user-1",
			entitlements: { customRoles: false },
		} as never);
		expect(refusal(await revokeGrant({ id: G1 }))?.kind).toBe("entitlement");
	});
});

describe("assignGrant validation", () => {
	it("rejects when both a role and a permission are provided", async () => {
		mockDb();
		expect(refusal(await assignGrant({
				principalType: "user",
				principalId: "u-1",
				effect: "allow",
				roleId: "r-1",
				permissionKey: "project:view",
				resourceType: "project",
			}))?.message).toMatch(/exactly one/);
	});

	it("rejects when neither a role nor a permission is provided", async () => {
		mockDb();
		expect(refusal(await assignGrant({
				principalType: "user",
				principalId: "u-1",
				effect: "allow",
				resourceType: "project",
			}))?.message).toMatch(/exactly one/);
	});

	// `"org"` is the DEFAULT resource kind here and on the CLI route, so a caller who names a
	// resource and forgets its kind would otherwise get an ORGANIZATION-WIDE grant while the call
	// reads as scoped to one project — the id persisted beside it and never read again. The wrong
	// outcome is wider than the intended one, so it is refused rather than collapsed.
	//
	// The controls for this live in "assignGrant persistence" below and are deliberately not
	// duplicated: an org kind with no id still stores org-wide, and a real kind with an id still
	// keeps that kind. Without them, over-refusing here would pass this test and break both.
	it("rejects an org-kind grant that also carries a resource id", async () => {
		mockDb();
		expect(refusal(await assignGrant({
				principalType: "user",
				principalId: "u-1",
				effect: "allow",
				permissionKey: "project:view",
				resourceType: "org",
				resourceId: "11111111-2222-3333-4444-555555555555",
			}))?.message).toMatch(/cannot carry a resource id/);
	});

	// The kind half of the scope (#4734). `resourceType` is a bare `string` on the wire, and since
	// #4584 an unrecognised kind is not inert: a DENY row whose scope resolves to nothing excludes
	// the WHOLE ORG on both engines. So `"projects"` — one plural — widens "deny project:deploy on
	// project P" to the entire organization, from a call that returns normally.
	//
	// Both directions are asserted: the refusal here, and every accepted kind in the walk below.
	// A validator that refused everything would close this bug and break the product.
	it("rejects an unrecognised resource kind and never inserts", async () => {
		const { insertSpy } = mockDb();
		expect(refusal(await assignGrant({
				principalType: "user",
				principalId: "u-1",
				effect: "deny",
				permissionKey: "project:deploy",
				resourceType: "projects",
				resourceId: "11111111-2222-3333-4444-555555555555",
			}))?.message).toMatch(UNKNOWN_RESOURCE_TYPE);
		expect(insertSpy).not.toHaveBeenCalled();
		expect(syncScopedGrant).not.toHaveBeenCalled();
	});

	it("names every accepted kind in that refusal", async () => {
		mockDb();
		const result = await assignGrant({
			principalType: "user",
			principalId: "u-1",
			effect: "deny",
			permissionKey: "project:deploy",
			resourceType: "projects",
			resourceId: "11111111-2222-3333-4444-555555555555",
		});
		const message = !result.ok && "message" in result.error ? result.error.message : "";
		for (const kind of GRANT_RESOURCE_TYPES) {
			expect(message).toContain(kind);
		}
	});

	// The id-less form is the quiet one: `resourceType` is collapsed to `"org"` when no id is
	// given, so an unrefused typo becomes a real ORGANIZATION-WIDE grant rather than a scoped one.
	it("rejects an unrecognised resource kind sent without a resource id", async () => {
		const { insertSpy } = mockDb();
		expect(refusal(await assignGrant({
				principalType: "user",
				principalId: "u-1",
				effect: "allow",
				permissionKey: "project:view",
				resourceType: "projects",
			}))?.message).toMatch(UNKNOWN_RESOURCE_TYPE);
		expect(insertSpy).not.toHaveBeenCalled();
	});

	// #4582: the kind used to be derived from the id's TRUTHINESS while the id was passed on as
	// given, so `("project", "")` reached the insert as `("org", "")` and Postgres rejected it
	// (resource_id is uuid) with an unnamed error. Nothing was stored; it is now refused by name.
	it("rejects an empty resource id on a scoped kind and never inserts", async () => {
		const { insertSpy } = mockDb();
		expect(refusal(await assignGrant({
				principalType: "user",
				principalId: "u-1",
				effect: "allow",
				permissionKey: "project:view",
				resourceType: "project",
				resourceId: "",
			}))?.message).toMatch(EMPTY_RESOURCE_ID);
		expect(insertSpy).not.toHaveBeenCalled();
		expect(syncScopedGrant).not.toHaveBeenCalled();
	});

	it("accepts every kind the hierarchy table makes scopable, plus org", async () => {
		// Derived from the same list the action validates against — which is itself derived from
		// `INSTANCE_TYPES` — so a kind added to the hierarchy cannot leave this boundary untested.
		// `connector` is the one exclusion: no organization owns a connector.
		expect([...GRANT_RESOURCE_TYPES]).toEqual([
			"org",
			...INSTANCE_TYPES.filter((k) => k !== "connector"),
		]);
		for (const kind of GRANT_RESOURCE_TYPES) {
			const { valuesSpy, insertSpy } = mockDb();
			const scoped = kind !== "org";
			await assignGrant({
				principalType: "user",
				principalId: "u-1",
				effect: "allow",
				permissionKey: "project:view",
				resourceType: kind,
				resourceId: scoped ? "11111111-2222-3333-4444-555555555555" : null,
			});
			expect(insertSpy).toHaveBeenCalledTimes(1);
			expect(valuesSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					resource_type: kind,
					resource_id: scoped ? "11111111-2222-3333-4444-555555555555" : null,
				}),
			);
		}
	});

	it("rejects an unknown permission key", async () => {
		mockDb();
		expect(refusal(await assignGrant({
				principalType: "user",
				principalId: "u-1",
				effect: "allow",
				permissionKey: "project:nuke",
				resourceType: "project",
			}))?.message).toMatch(/Unknown permission/);
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
				permissionKey: "project:view",
				roleId: null,
			}),
		);
		// The org arm of `GrantScope` has no resourceId field at all (#4582) — not even a null one.
		expect(syncScopedGrant.mock.calls[0]?.[0]).not.toHaveProperty("resourceId");
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
		).resolves.toEqual({ ok: true, data: { assigned: true } });
	});
});

describe("revokeGrant", () => {
	it("no-ops (no delete / no tuple removal) when the grant is not found", async () => {
		const { deleteSpy } = mockDb([]); // select().limit(1) → []
		await revokeGrant({ id: MISSING });
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
		await revokeGrant({ id: G1 });

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
		await revokeGrant({ id: G2 });
		expect(removeScopedGrant).toHaveBeenCalledWith(
			expect.objectContaining({
				principalType: "user",
				effect: "allow",
				roleId: "role-3",
				resourceType: "org",
			}),
		);
		expect(removeScopedGrant.mock.calls[0]?.[0]).not.toHaveProperty("resourceId");
	});

	// #4582: a stored row is NARROWED to a `GrantScope` (the #4584 ruling), not spread into one.
	it("does not call removeScopedGrant for an ALLOW row of the bad pair — it confers nothing", async () => {
		const { deleteSpy } = mockDb([
			{
				id: "g-3",
				org_id: "org-1",
				principal_type: "user",
				principal_id: "u-5",
				effect: "allow",
				role_id: null,
				permission_key: "project:view",
				resource_type: "org",
				resource_id: "p-1",
			},
		]);
		await revokeGrant({ id: G3 });
		// The row itself is still deleted — only the tuple removal has nothing to act on.
		expect(deleteSpy).toHaveBeenCalledTimes(1);
		expect(removeScopedGrant).not.toHaveBeenCalled();
	});

	it("removes a DENY row of the bad pair at the ORG scope — it excluded org-wide (#4584)", async () => {
		mockDb([
			{
				id: "g-4",
				org_id: "org-1",
				principal_type: "user",
				principal_id: "u-5",
				effect: "deny",
				role_id: null,
				permission_key: "project:deploy",
				resource_type: "org",
				resource_id: "p-1",
			},
		]);
		await revokeGrant({ id: G4 });
		expect(removeScopedGrant).toHaveBeenCalledWith({
			orgId: "org-1",
			principalType: "user",
			principalId: "u-5",
			effect: "deny",
			resourceType: "org",
			roleId: null,
			permissionKey: "project:deploy",
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

describe("assignGrant refuses a reference outside the actor's org", () => {
	it("answers forbidden for every binding reason, before the ceiling, and never inserts", async () => {
		const { insertSpy } = mockDb();
		const reasons: GrantBindingReason[] = ["foreign_role", "foreign_team", "foreign_resource"];
		for (const reason of reasons) {
			vi.mocked(grantBindingViolation).mockResolvedValueOnce(reason);
			// The reason is the server's (logged with the PDP's denial); the client is told only that
			// the grant was refused — it never learns which of the three references was foreign.
			const result = await assignGrant({
				principalType: "user",
				principalId: "u-1",
				effect: "allow",
				roleId: "role-x",
				resourceType: "org",
			});
			expect(refusal(result)?.kind).toBe("forbidden");
		}
		expect(insertSpy).not.toHaveBeenCalled();
		expect(can).not.toHaveBeenCalled();
		expect(vi.mocked(grantBindingViolation)).toHaveBeenLastCalledWith({
			orgId: "org-1",
			principalType: "user",
			principalId: "u-1",
			roleId: "role-x",
			resource: { resourceType: "org" },
		});
	});
});

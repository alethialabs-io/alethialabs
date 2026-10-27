// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the custom-role actions (each a `defineAction` since #6129, so every
// refusal is asserted as its typed `ActionResult`) and the custom-role read (`listCustomRoles`, now
// in lib/rpc/procedures/members.ts): stub the actor, a queue-based thenable
// drizzle chain (each awaited terminal/.returning() shifts the next seeded result-set), and the
// side-effect deps (alerts, activity, tuple-sync). The entitlement math (getEntitlements) and the
// permission registry/`sanitize` stay REAL, so we assert the Enterprise gate, key sanitisation,
// the not-found guard, and which dep was called with what.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ authorizeQuiet: vi.fn() }));
// The privilege ceiling calls the real PDP (getPdp().can → db); mock it to "within ceiling" by
// default so these unit tests exercise the gate/DB behavior. The ceiling's own denial is proven
// against the real PDP in tests/integration/roles-authz.test.ts.
vi.mock("@/lib/authz/ceiling", () => ({
	actorHoldsAllKeys: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/alerts/emit", () => ({ emitAlertEventSafe: vi.fn() }));
vi.mock("@/lib/authz/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/authz/tuple-sync", () => ({ getTupleSync: vi.fn() }));

import { createRole, deleteRole, updateRole } from "@/app/server/actions/roles";
import { listCustomRoles } from "@/lib/rpc/procedures/members";
import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { recordActivity } from "@/lib/authz/activity";
import { authorizeQuiet } from "@/lib/authz/guard";
import { getTupleSync } from "@/lib/authz/tuple-sync";
import { ForbiddenError } from "@/lib/authz/types";
import { getServiceDb } from "@/lib/db";

/** Role ids as the actions now require them: uuids. */
const R1 = "00000000-0000-4000-8000-0000000000b1";
const R2 = "00000000-0000-4000-8000-0000000000b2";
const RX = "00000000-0000-4000-8000-0000000000bf";

/**
 * A drizzle-ish chain where every builder returns the chain and each awaited terminal
 * (`.then` / `.returning()` / `.limit()`) shifts the next seeded result-set off a queue.
 * Spies capture `.insert()`/`.delete()` tables, `.values()` payloads, and `.set()` writes.
 */
function mockDb(queue: unknown[]) {
	const insertTables: unknown[] = [];
	const deleteTables: unknown[] = [];
	const valuesCalls: unknown[] = [];
	const setSpy = vi.fn();
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		select: () => db,
		from: () => db,
		where: () => db,
		limit: () => db,
		update: () => db,
		insert: (table: unknown) => {
			insertTables.push(table);
			return db;
		},
		delete: (table: unknown) => {
			deleteTables.push(table);
			return db;
		},
		values: (v: unknown) => {
			valuesCalls.push(v);
			return db;
		},
		set: (...a: unknown[]) => {
			setSpy(...a);
			return db;
		},
		returning: () => db,
		then: (resolve: (v: unknown) => void) => resolve(queue.shift()),
	});
	vi.mocked(getServiceDb).mockReturnValue(db as never);
	return { insertTables, deleteTables, valuesCalls, setSpy };
}

/** Actor in an org WITHOUT the customRoles entitlement (community baseline). The PDP gate
 *  (authorizeQuiet) is satisfied — it resolves the actor — so the denial under test is the
 *  entitlement, not authorization. */
function communityActor() {
	vi.mocked(authorizeQuiet).mockResolvedValue({
		orgId: "org-1",
		userId: "user-1",
	} as never);
}

/** Actor in an org WITH the customRoles entitlement (Enterprise) and the PDP gate satisfied. */
function enterpriseActor() {
	vi.mocked(authorizeQuiet).mockResolvedValue({
		orgId: "org-1",
		userId: "user-1",
		entitlements: { customRoles: true },
	} as never);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getTupleSync).mockReturnValue({
		resyncRole: vi.fn(() => Promise.resolve()),
	} as never);
});

describe("PDP gate (authorizeQuiet) — a member without manage_members is blocked", () => {
	// A viewer/operator holds a role but NOT `member:manage_members`, so the real PDP denies the
	// mutations; here we simulate that by making authorizeQuiet throw and assert no DB write happens.
	// (The real-PDP proof is tests/integration/roles-authz.test.ts.)
	const deny = () =>
		vi
			.mocked(authorizeQuiet)
			.mockRejectedValue(
				new ForbiddenError("manage_members", { type: "member" }, "no_grant"),
			);

	it("createRole answers forbidden and never inserts", async () => {
		const { insertTables } = mockDb([]);
		deny();
		expect(await createRole({ name: "Eng", permissionKeys: ["org:view"] })).toMatchObject({ ok: false, error: { kind: "forbidden" } });
		expect(insertTables).toHaveLength(0);
	});

	it("updateRole answers forbidden and never writes", async () => {
		const { insertTables, deleteTables, setSpy } = mockDb([]);
		deny();
		expect(await updateRole({ id: R1, name: "Eng", permissionKeys: ["org:view"] })).toMatchObject({ ok: false, error: { kind: "forbidden" } });
		expect(insertTables).toHaveLength(0);
		expect(deleteTables).toHaveLength(0);
		expect(setSpy).not.toHaveBeenCalled();
	});

	it("deleteRole answers forbidden and never deletes", async () => {
		const { deleteTables } = mockDb([]);
		deny();
		expect(await deleteRole({ id: R1 })).toMatchObject({ ok: false, error: { kind: "forbidden" } });
		expect(deleteTables).toHaveLength(0);
	});
});

describe("listCustomRoles", () => {
	it("returns an empty array when the org has no custom roles", async () => {
		communityActor();
		mockDb([[]]); // role select → none
		expect(await listCustomRoles()).toEqual([]);
	});

	it("groups permission keys under each role", async () => {
		communityActor();
		mockDb([
			[
				{ id: R1, name: "Eng" },
				{ id: R2, name: "Ops" },
			],
			[
				{ roleId: R1, key: "org:view" },
				{ roleId: R1, key: "project:create" },
				{ roleId: R2, key: "runner:view" },
			],
		]);
		const roles = await listCustomRoles();
		expect(roles).toEqual([
			{ id: R1, name: "Eng", permissionKeys: ["org:view", "project:create"] },
			{ id: R2, name: "Ops", permissionKeys: ["runner:view"] },
		]);
	});

	it("does not require the customRoles entitlement (read path)", async () => {
		communityActor();
		mockDb([[]]);
		await expect(listCustomRoles()).resolves.toEqual([]);
	});
});

describe("createRole", () => {
	it("answers entitlement when the org lacks the customRoles entitlement", async () => {
		communityActor();
		expect(await createRole({ name: "Eng", permissionKeys: ["org:view"] })).toMatchObject({ ok: false, error: { kind: "entitlement" } });
	});

	it("creates the role, persists sanitised keys, and emits side-effects", async () => {
		enterpriseActor();
		const { insertTables, valuesCalls } = mockDb([
			[{ id: R1, name: "Eng" }], // role insert .returning()
			[], // rolePermission insert
		]);

		const result = await createRole({ name: "Eng", permissionKeys: [
			"org:view",
			"org:view", // duplicate → de-duped
			"project:create",
			"bogus:nope", // unknown → dropped
		] });

		expect(result).toEqual({
			ok: true,
			data: { id: R1, name: "Eng", permissionKeys: ["org:view", "project:create"] },
		});
		// First insert is the role row with the active org + non-builtin flag.
		expect(valuesCalls[0]).toEqual({
			organization_id: "org-1",
			name: "Eng",
			description: null,
			is_builtin: false,
		});
		// Second insert is one rolePermission row per sanitised key.
		expect(valuesCalls[1]).toEqual([
			{ role_id: R1, permission_key: "org:view" },
			{ role_id: R1, permission_key: "project:create" },
		]);
		expect(insertTables).toHaveLength(2);

		expect(emitAlertEventSafe).toHaveBeenCalledWith(
			"org-1",
			"authz.role.create",
			expect.objectContaining({ action: "create", resource_id: R1 }),
		);
		expect(recordActivity).toHaveBeenCalledWith(
			expect.objectContaining({ orgId: "org-1" }),
			"create",
			{ type: "role", id: R1 },
		);
	});

	it("skips the permission insert when no valid keys remain", async () => {
		enterpriseActor();
		const { valuesCalls } = mockDb([[{ id: R1, name: "Eng" }]]);
		const result = await createRole({ name: "Eng", permissionKeys: ["bogus:nope", "also:bad"] });
		expect(result.ok && result.data.permissionKeys).toEqual([]);
		expect(valuesCalls).toHaveLength(1); // only the role row, no rolePermission insert
	});
});

describe("updateRole", () => {
	it("answers entitlement when the org lacks the customRoles entitlement", async () => {
		communityActor();
		expect(await updateRole({ id: R1, name: "Eng", permissionKeys: [] })).toMatchObject({ ok: false, error: { kind: "entitlement" } });
	});

	it("answers not-found when the role isn't an editable org role", async () => {
		enterpriseActor();
		mockDb([[]]); // target lookup → none
		expect(await updateRole({ id: RX, name: "Eng", permissionKeys: ["org:view"] })).toMatchObject({
			ok: false,
			error: { kind: "not-found" },
		});
	});

	it("renames, replaces permissions, resyncs tuples, and emits side-effects", async () => {
		enterpriseActor();
		const resyncRole = vi.fn(() => Promise.resolve());
		vi.mocked(getTupleSync).mockReturnValue({ resyncRole } as never);
		const { setSpy, valuesCalls, deleteTables } = mockDb([
			[{ id: R1 }], // target lookup
			[], // update
			[], // delete rolePermission
			[], // insert rolePermission
		]);

		await updateRole({ id: R1, name: "Renamed", permissionKeys: ["org:view", "junk:key"] });

		expect(setSpy).toHaveBeenCalledWith({ name: "Renamed", description: null });
		expect(deleteTables).toHaveLength(1); // old permissions cleared
		expect(valuesCalls[0]).toEqual([{ role_id: R1, permission_key: "org:view" }]);
		expect(resyncRole).toHaveBeenCalledWith(R1);

		expect(emitAlertEventSafe).toHaveBeenCalledWith(
			"org-1",
			"authz.role.edit",
			expect.objectContaining({ action: "edit", resource_id: R1, severity: "warning" }),
		);
		expect(recordActivity).toHaveBeenCalledWith(
			expect.objectContaining({ orgId: "org-1" }),
			"edit",
			{ type: "role", id: R1 },
		);
	});

	it("does not re-insert permissions when none survive sanitisation", async () => {
		enterpriseActor();
		const { valuesCalls } = mockDb([[{ id: R1 }], [], []]);
		await updateRole({ id: R1, name: "Renamed", permissionKeys: ["junk:key"] });
		expect(valuesCalls).toHaveLength(0); // delete happened, but no insert
	});
});

describe("deleteRole", () => {
	it("answers entitlement when the org lacks the customRoles entitlement", async () => {
		communityActor();
		expect(await deleteRole({ id: R1 })).toMatchObject({ ok: false, error: { kind: "entitlement" } });
	});

	it("deletes the org's role and emits the destroy side-effects", async () => {
		enterpriseActor();
		const { deleteTables } = mockDb([[]]);
		await deleteRole({ id: R1 });
		expect(deleteTables).toHaveLength(1);
		expect(emitAlertEventSafe).toHaveBeenCalledWith(
			"org-1",
			"authz.role.delete",
			expect.objectContaining({ action: "delete", resource_id: R1, severity: "warning" }),
		);
		expect(recordActivity).toHaveBeenCalledWith(
			expect.objectContaining({ orgId: "org-1" }),
			"destroy",
			{ type: "role", id: R1 },
		);
	});
});

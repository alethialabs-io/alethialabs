// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary tests for the custom-role actions: stub the actor, a queue-based thenable
// drizzle chain (each awaited terminal/.returning() shifts the next seeded result-set), and the
// side-effect deps (alerts, activity, tuple-sync). The entitlement math (getEntitlements) and the
// permission registry/`sanitize` stay REAL, so we assert the Enterprise gate, key sanitisation,
// the not-found guard, and which dep was called with what.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ currentActor: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/alerts/emit", () => ({ emitAlertEventSafe: vi.fn() }));
vi.mock("@/lib/authz/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/authz/tuple-sync", () => ({ getTupleSync: vi.fn() }));

import {
	createRole,
	deleteRole,
	listCustomRoles,
	updateRole,
} from "@/app/server/actions/roles";
import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { recordActivity } from "@/lib/authz/activity";
import { currentActor } from "@/lib/authz/guard";
import { getTupleSync } from "@/lib/authz/tuple-sync";
import { getServiceDb } from "@/lib/db";

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

/** Actor in an org WITHOUT the customRoles entitlement (community baseline). */
function communityActor() {
	vi.mocked(currentActor).mockResolvedValue({
		orgId: "org-1",
		userId: "user-1",
	} as never);
}

/** Actor in an org WITH the customRoles entitlement (Enterprise). */
function enterpriseActor() {
	vi.mocked(currentActor).mockResolvedValue({
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
				{ id: "r-1", name: "Eng" },
				{ id: "r-2", name: "Ops" },
			],
			[
				{ roleId: "r-1", key: "org:view" },
				{ roleId: "r-1", key: "project:create" },
				{ roleId: "r-2", key: "runner:view" },
			],
		]);
		const roles = await listCustomRoles();
		expect(roles).toEqual([
			{ id: "r-1", name: "Eng", permissionKeys: ["org:view", "project:create"] },
			{ id: "r-2", name: "Ops", permissionKeys: ["runner:view"] },
		]);
	});

	it("does not require the customRoles entitlement (read path)", async () => {
		communityActor();
		mockDb([[]]);
		await expect(listCustomRoles()).resolves.toEqual([]);
	});
});

describe("createRole", () => {
	it("throws when the org lacks the customRoles entitlement", async () => {
		communityActor();
		await expect(createRole("Eng", ["org:view"])).rejects.toThrow(
			/Enterprise license/,
		);
	});

	it("creates the role, persists sanitised keys, and emits side-effects", async () => {
		enterpriseActor();
		const { insertTables, valuesCalls } = mockDb([
			[{ id: "r-1", name: "Eng" }], // role insert .returning()
			[], // rolePermission insert
		]);

		const result = await createRole("Eng", [
			"org:view",
			"org:view", // duplicate → de-duped
			"project:create",
			"bogus:nope", // unknown → dropped
		]);

		expect(result).toEqual({
			id: "r-1",
			name: "Eng",
			permissionKeys: ["org:view", "project:create"],
		});
		// First insert is the role row with the active org + non-builtin flag.
		expect(valuesCalls[0]).toEqual({
			organization_id: "org-1",
			name: "Eng",
			is_builtin: false,
		});
		// Second insert is one rolePermission row per sanitised key.
		expect(valuesCalls[1]).toEqual([
			{ role_id: "r-1", permission_key: "org:view" },
			{ role_id: "r-1", permission_key: "project:create" },
		]);
		expect(insertTables).toHaveLength(2);

		expect(emitAlertEventSafe).toHaveBeenCalledWith(
			"org-1",
			"authz.role.create",
			expect.objectContaining({ action: "create", resource_id: "r-1" }),
		);
		expect(recordActivity).toHaveBeenCalledWith(
			expect.objectContaining({ orgId: "org-1" }),
			"create",
			{ type: "role", id: "r-1" },
		);
	});

	it("skips the permission insert when no valid keys remain", async () => {
		enterpriseActor();
		const { valuesCalls } = mockDb([[{ id: "r-1", name: "Eng" }]]);
		const result = await createRole("Eng", ["bogus:nope", "also:bad"]);
		expect(result.permissionKeys).toEqual([]);
		expect(valuesCalls).toHaveLength(1); // only the role row, no rolePermission insert
	});
});

describe("updateRole", () => {
	it("throws when the org lacks the customRoles entitlement", async () => {
		communityActor();
		await expect(updateRole("r-1", "Eng", [])).rejects.toThrow(
			/Enterprise license/,
		);
	});

	it("throws when the role isn't an editable org role", async () => {
		enterpriseActor();
		mockDb([[]]); // target lookup → none
		await expect(updateRole("r-x", "Eng", ["org:view"])).rejects.toThrow(
			/Role not found/,
		);
	});

	it("renames, replaces permissions, resyncs tuples, and emits side-effects", async () => {
		enterpriseActor();
		const resyncRole = vi.fn(() => Promise.resolve());
		vi.mocked(getTupleSync).mockReturnValue({ resyncRole } as never);
		const { setSpy, valuesCalls, deleteTables } = mockDb([
			[{ id: "r-1" }], // target lookup
			[], // update
			[], // delete rolePermission
			[], // insert rolePermission
		]);

		await updateRole("r-1", "Renamed", ["org:view", "junk:key"]);

		expect(setSpy).toHaveBeenCalledWith({ name: "Renamed" });
		expect(deleteTables).toHaveLength(1); // old permissions cleared
		expect(valuesCalls[0]).toEqual([{ role_id: "r-1", permission_key: "org:view" }]);
		expect(resyncRole).toHaveBeenCalledWith("r-1");

		expect(emitAlertEventSafe).toHaveBeenCalledWith(
			"org-1",
			"authz.role.edit",
			expect.objectContaining({ action: "edit", resource_id: "r-1", severity: "warning" }),
		);
		expect(recordActivity).toHaveBeenCalledWith(
			expect.objectContaining({ orgId: "org-1" }),
			"edit",
			{ type: "role", id: "r-1" },
		);
	});

	it("does not re-insert permissions when none survive sanitisation", async () => {
		enterpriseActor();
		const { valuesCalls } = mockDb([[{ id: "r-1" }], [], []]);
		await updateRole("r-1", "Renamed", ["junk:key"]);
		expect(valuesCalls).toHaveLength(0); // delete happened, but no insert
	});
});

describe("deleteRole", () => {
	it("throws when the org lacks the customRoles entitlement", async () => {
		communityActor();
		await expect(deleteRole("r-1")).rejects.toThrow(/Enterprise license/);
	});

	it("deletes the org's role and emits the destroy side-effects", async () => {
		enterpriseActor();
		const { deleteTables } = mockDb([[]]);
		await deleteRole("r-1");
		expect(deleteTables).toHaveLength(1);
		expect(emitAlertEventSafe).toHaveBeenCalledWith(
			"org-1",
			"authz.role.delete",
			expect.objectContaining({ action: "delete", resource_id: "r-1", severity: "warning" }),
		);
		expect(recordActivity).toHaveBeenCalledWith(
			expect.objectContaining({ orgId: "org-1" }),
			"destroy",
			{ type: "role", id: "r-1" },
		);
	});
});

// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The CLI component wire must not carry `org_id` in `config` (#4847).
//
// #4823 added a server-managed `org_id` to every component table. `rowToComponentWire` copies each
// column NOT in its deny list into `config`, and both read paths hand it the whole row —
// `listProjectComponents` selects `getTableColumns(table)`, `insertProjectComponent` uses
// `.returning()` — so every list/add/upsert response started carrying the tenancy column as if it
// were user config. The older mocked tests could not see it because their fixture rows had no
// `org_id`; every fixture row here HAS one, and that is the point of this file.
//
// Only `getServiceDb` is mocked. The three functions under test run for real, so a regression in
// the deny list — or a new read path that bypasses it — fails here.

import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const PROJ_ID = "22222222-2222-4222-8222-222222222222";
const ENV_ID = "33333333-3333-4333-8333-333333333333";
const ROW_ID = "44444444-4444-4444-8444-444444444444";

/** A stored component row as Postgres returns it after #4823: the tenancy column is present. */
function storedRow(extra: Record<string, unknown>): Record<string, unknown> {
	return {
		id: ROW_ID,
		org_id: ORG_ID,
		project_id: PROJ_ID,
		environment_id: ENV_ID,
		created_at: "2026-09-18T12:00:00.000Z",
		updated_at: "2026-09-18T12:00:00.000Z",
		status: "pending",
		region: "eu-central-1",
		...extra,
	};
}

/** What the insert was asked to write, so a test can confirm the mock echoed it back. */
let insertedValues: Record<string, unknown> | undefined;

/**
 * A minimal awaitable stand-in for a drizzle query builder: every chain method returns the same
 * builder and awaiting it yields `rows`. `.as()` (the count subquery) returns it too, and is only
 * ever passed back into `.from()`, where it is ignored.
 */
function builder(rows: () => unknown[]) {
	const self = {
		from: () => self,
		where: () => self,
		orderBy: () => self,
		limit: () => self,
		as: () => self,
		then: (
			onFulfilled: (value: unknown[]) => unknown,
			onRejected?: (reason: unknown) => unknown,
		) => Promise.resolve(rows()).then(onFulfilled, onRejected),
	};
	return self;
}

vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({
		// Three selects reach the DB: the capped count (`{ n }`), the Fabric lookup for a
		// fabric-carrying table, and the page rows. They are told apart by the projection's keys.
		select: (fields?: Record<string, unknown>) => {
			if (fields && "n" in fields) return builder(() => [{ n: 1 }]);
			if (fields && "hit" in fields) return builder(() => []);
			if (fields && "placement_mode" in fields) {
				return builder(() => [
					{ fabric_id: null, placement_mode: "dedicated" },
				]);
			}
			return builder(() => [
				storedRow({
					name: "orders",
					engine: "postgres",
					cursor_key: "2026-09-18T12:00:00.000000Z",
				}),
			]);
		},
		// db.insert(t).values(v)[.onConflictDoUpdate({set})].returning() → [stored row + v]
		insert: () => ({
			values: (v: Record<string, unknown>) => {
				insertedValues = v;
				const returning = async () => [storedRow(v)];
				return {
					onConflictDoUpdate: () => ({ returning }),
					returning,
				};
			},
		}),
	}),
}));

const { insertProjectComponent, listProjectComponents, rowToComponentWire } =
	await import("@/lib/cli/project-components");

describe("component wire — org_id is never config (#4847)", () => {
	beforeEach(() => {
		insertedValues = undefined;
	});

	it("rowToComponentWire drops org_id and keeps the kind's real config", () => {
		const wire = rowToComponentWire(
			"databases",
			storedRow({ name: "orders", engine: "postgres" }),
		);
		expect(wire.config).not.toHaveProperty("org_id");
		// The fixture must actually carry the column, or the assertion above proves nothing.
		expect(storedRow({})).toHaveProperty("org_id", ORG_ID);
		expect(wire.config).toMatchObject({
			engine: "postgres",
			region: "eu-central-1",
		});
	});

	it("list: a page of rows selected with org_id carries none in config", async () => {
		const page = await listProjectComponents(
			{ orgId: ORG_ID, projectId: PROJ_ID, kindFilter: "databases" },
			{ limit: 10, after: null },
		);
		expect(page.components).toHaveLength(1);
		const [component] = page.components;
		expect(component?.config).not.toHaveProperty("org_id");
		expect(component?.config).toHaveProperty("engine", "postgres");
	});

	it("add: a multi-kind insert returning org_id carries none in config", async () => {
		const wire = await insertProjectComponent(
			"databases",
			PROJ_ID,
			ENV_ID,
			"orders",
			{ engine: "postgres" },
		);
		expect(insertedValues).toHaveProperty("name", "orders");
		expect(wire.config).not.toHaveProperty("org_id");
		expect(wire.config).toHaveProperty("engine", "postgres");
	});

	it("upsert: a singleton ON CONFLICT returning org_id carries none in config", async () => {
		const wire = await insertProjectComponent("network", PROJ_ID, ENV_ID, "", {
			cidr_block: "10.0.0.0/16",
		});
		expect(wire.config).not.toHaveProperty("org_id");
		expect(wire.config).toHaveProperty("cidr_block", "10.0.0.0/16");
	});

	it("upsert through a fabric-carrying singleton carries none in config", async () => {
		const wire = await insertProjectComponent("cluster", PROJ_ID, ENV_ID, "", {
			cluster_version: "1.35",
		});
		expect(wire.config).not.toHaveProperty("org_id");
		expect(wire.config).toHaveProperty("cluster_version", "1.35");
	});
});

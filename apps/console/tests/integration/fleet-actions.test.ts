// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the fleet_actions durable ledger against real Postgres. Proves insertFleetAction
// maps every field (provider/action enums, runner FK, reason, queue_depth, pool_size, jsonb
// metadata) onto a real row — the kind of enum/column mapping a mocked db.insert can't catch.

import { randomUUID } from "node:crypto";
import { desc, eq, inArray } from "drizzle-orm";
import { afterAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { fleetActions, runners } from "@/lib/db/schema";
import { insertFleetAction } from "@/lib/fleet/queue";
import { describeIfDb } from "./db";

describeIfDb("fleet_actions ledger", () => {
	let runnerId: string;

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(fleetActions).where(eq(fleetActions.runner_id, runnerId));
		// Also clean the create row (runner_id NULL) by provider+reason marker below.
		await db.delete(runners).where(inArray(runners.id, [runnerId]));
	});

	it("writes a create action (no runner) with reason + decision inputs", async () => {
		const marker = `civo`;
		await insertFleetAction({
			provider: "civo",
			action: "create",
			reason: "scale-up-demand",
			runnerId: null,
			queueDepth: 7,
			poolSize: 2,
			metadata: { location: "fra1", version: "v9" },
		});
		const [row] = await getServiceDb()
			.select()
			.from(fleetActions)
			.where(eq(fleetActions.provider, marker))
			.orderBy(desc(fleetActions.created_at))
			.limit(1);
		expect(row.action).toBe("create");
		expect(row.reason).toBe("scale-up-demand");
		expect(row.runner_id).toBeNull();
		expect(row.count).toBe(1); // column default
		expect(row.queue_depth).toBe(7);
		expect(row.pool_size).toBe(2);
		expect(row.metadata).toEqual({ location: "fra1", version: "v9" });
		await getServiceDb().delete(fleetActions).where(eq(fleetActions.id, row.id));
	});

	it("writes a destroy action carrying the correlated runner id", async () => {
		const [r] = await getServiceDb()
			.insert(runners)
			.values({
				name: `fleet-action-${randomUUID().slice(0, 8)}`,
				operator: "managed",
				token_hash: `hash-${randomUUID()}`,
				status: "OFFLINE",
			})
			.returning({ id: runners.id });
		runnerId = r.id;
		await insertFleetAction({
			provider: "hetzner",
			action: "destroy",
			reason: "scale-down-idle",
			runnerId,
			queueDepth: 0,
			poolSize: 3,
			metadata: { instance_id: "srv-123", location: "nbg1" },
		});
		const [row] = await getServiceDb()
			.select()
			.from(fleetActions)
			.where(eq(fleetActions.runner_id, runnerId))
			.limit(1);
		expect(row.action).toBe("destroy");
		expect(row.reason).toBe("scale-down-idle");
		expect(row.provider).toBe("hetzner");
		expect(row.metadata?.instance_id).toBe("srv-123");
	});
});

// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (real Postgres): the Activity log walks the console's one keyset contract
// (LST-10 #7492). What a mocked db cannot show, and so what is proved here: a walk whose page
// boundaries fall INSIDE ties on `ts` — including events in the same millisecond but different
// microseconds, which a JS `Date` cursor cannot tell apart — visits every event of the scope exactly
// once, newest first, and a filter changes the universe the walk covers without changing that.

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { authzActivityLog } from "@/lib/db/schema";
import { queryActivityPage } from "@/lib/queries/activity";
import { decodeKeysetCursor } from "@/lib/queries/keyset";
import type { ActivityQuery } from "@/app/server/actions/activity";
import { describeIfDb, purgeAuthzActivityLog } from "./db";

describeIfDb("Activity log keyset walk (LST-10)", () => {
	const orgId = randomUUID();
	const ada = randomUUID();
	const grace = randomUUID();
	/** Rows per page: small, so every boundary of the walk lands inside one of the ties below. */
	const LIMIT = 2;

	beforeAll(async () => {
		// Nine events. Four share one microsecond; three share one millisecond across different
		// microseconds; two stand alone. All recent, so no window question arises.
		const at = (expr: string) => sql.raw(`now() - interval '${expr}'`);
		const rows = [
			{ actor: ada, ts: at("1 minute") },
			{ actor: grace, ts: at("2 minutes") },
			...[0, 1, 2, 3].map((i) => ({ actor: i % 2 === 0 ? ada : grace, ts: at("3 minutes") })),
			...[1, 2, 3].map((us) => ({ actor: us % 2 === 0 ? ada : grace, ts: at(`4 minutes ${us} microseconds`) })),
		];
		await getServiceDb()
			.insert(authzActivityLog)
			.values(
				rows.map((r, i) => ({
					org_id: orgId,
					actor_id: r.actor,
					action: `org:update:${i}`,
					resource_type: "project",
					resource_id: null,
					decision: true,
					reason: "lst-10-walk",
					ts: r.ts,
				})),
			);
	});

	afterAll(async () => {
		await purgeAuthzActivityLog(eq(authzActivityLog.org_id, orgId));
	});

	/** Walks every page of `query`, returning the ids in the order the pages gave them. */
	async function walk(query: ActivityQuery = {}): Promise<string[]> {
		const ids: string[] = [];
		let cursor: string | null = null;
		for (let pages = 0; pages < 20; pages++) {
			const decoded = cursor === null ? undefined : (decodeKeysetCursor(cursor, "integer") ?? undefined);
			const page = await queryActivityPage(orgId, query, { limit: LIMIT, cursor: decoded });
			ids.push(...page.rows.map((r) => r.id));
			if (page.nextCursor === null) return ids;
			cursor = page.nextCursor;
		}
		throw new Error("the walk never ended");
	}

	/** Every id of the org's events, in the contract's order, read in one go. */
	async function everyId(actor?: string): Promise<string[]> {
		const rows = await getServiceDb()
			.select({ id: authzActivityLog.id })
			.from(authzActivityLog)
			.where(
				actor === undefined
					? eq(authzActivityLog.org_id, orgId)
					: sql`${authzActivityLog.org_id} = ${orgId} and ${authzActivityLog.actor_id} = ${actor}`,
			)
			.orderBy(sql`date_trunc('milliseconds', ${authzActivityLog.ts}) desc, ${authzActivityLog.id} desc`);
		return rows.map((r) => String(r.id));
	}

	it("visits every event exactly once across boundaries inside ties, in the contract's order", async () => {
		const ids = await walk();
		expect(ids).toHaveLength(9);
		expect(new Set(ids).size).toBe(9);
		expect(ids).toEqual(await everyId());
	});

	it("a filter walks its own universe the same way", async () => {
		const ids = await walk({ actorIds: [grace] });
		expect(ids).toEqual(await everyId(grace));
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("answers universeEmpty on the first page only", async () => {
		const first = await queryActivityPage(orgId, {}, { limit: LIMIT });
		expect(first.universeEmpty).toBe(false);
		const empty = await queryActivityPage(randomUUID(), {}, { limit: LIMIT });
		expect(empty.universeEmpty).toBe(true);
		const cursor = first.nextCursor === null ? undefined : (decodeKeysetCursor(first.nextCursor, "integer") ?? undefined);
		const later = await queryActivityPage(orgId, {}, { limit: LIMIT, cursor });
		expect(later.universeEmpty).toBeNull();
	});
});

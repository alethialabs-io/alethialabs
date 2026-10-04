// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the #5481 data migration that returns legacy `personal` cloud identities in a team
// org to `org` scope, against real Postgres.
//
// Migration 0011 added `cloud_identities.scope` with a `personal` default, so every row that already
// existed became `personal`, whatever org it sat in. #5481 then made the claim route and the actor
// identity checks admit a team org's identity to other members only when it is `org` scope. The
// data migration converts the rows 0011 mislabelled, which restores the sharing they had before it.
//
// This test runs THE SHIPPED SQL: the text between the #5481 BEGIN/END markers, read from whichever
// migration file carries them. It seeds a legacy row (personal, team org) and a true personal row
// (org_id = user_id), runs the SQL twice, and asserts that only the first is converted and the
// second run changes nothing. It then asserts the tightened checks admit a teammate to the converted
// row. Everything runs in one transaction that is rolled back, so no other suite sees the UPDATE.

import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { inArray, sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { cloudIdentities } from "@/lib/db/schema";
import {
	actorIdentityWhere,
	claimIdentityWhere,
} from "@/lib/runners/claim-identity";
import { describeIfDb } from "./db";

const BEGIN = "-- ── #5481 data: BEGIN";
const END = "-- ── #5481 data: END";

/**
 * The statements between the #5481 markers, from the one migration file that carries them. Returns
 * an empty list when no file does, so a missing migration fails this suite on its assertions.
 */
function convertStatements(): string[] {
	const dir = join(__dirname, "../../lib/db/migrations");
	const carriers = readdirSync(dir)
		.filter((f) => f.endsWith(".sql"))
		.map((f) => readFileSync(join(dir, f), "utf8"))
		.filter((text) => text.includes(BEGIN));
	if (carriers.length > 1) throw new Error("two migrations carry the #5481 markers");
	const [file] = carriers;
	if (file === undefined) return [];
	const begin = file.indexOf(BEGIN);
	const end = file.indexOf(END);
	if (end < begin) throw new Error("the #5481 END marker precedes its BEGIN marker");
	return file
		.slice(begin, end)
		.split("--> statement-breakpoint")
		.map((s) => s.trim())
		.filter((s) => s.replace(/--[^\n]*/g, "").trim().length > 0);
}

/** Thrown to roll the test's transaction back once its assertions have passed. */
class RollbackAfterAssertions extends Error {}

describeIfDb("legacy personal identity → org scope (#5481)", () => {
	it("converts a personal identity in a team org, leaves a true personal one, and is idempotent", async () => {
		const author = randomUUID();
		const teammate = randomUUID();
		const teamOrg = randomUUID();

		const run = getServiceDb().transaction(async (tx) => {
			const [legacy, personal, alreadyOrg] = await tx
				.insert(cloudIdentities)
				.values([
					// A pre-0011 row in a team org: defaulted to `personal` by 0011.
					{ user_id: author, org_id: teamOrg, scope: "personal", provider: "aws", name: "it-5481-legacy" },
					// A true personal identity: it sits in its author's personal org.
					{ user_id: author, org_id: author, scope: "personal", provider: "aws", name: "it-5481-personal" },
					// Already shared: the migration must leave it exactly as it is.
					{ user_id: teammate, org_id: teamOrg, scope: "org", provider: "aws", name: "it-5481-org" },
				])
				.returning({ id: cloudIdentities.id });
			const ids = [legacy.id, personal.id, alreadyOrg.id];

			/** The seeded rows' scopes, keyed by id. */
			const scopes = async () =>
				new Map(
					(
						await tx
							.select({ id: cloudIdentities.id, scope: cloudIdentities.scope })
							.from(cloudIdentities)
							.where(inArray(cloudIdentities.id, ids))
					).map((r) => [r.id, r.scope]),
				);

			// Before: the tightened claim arm refuses the legacy row to a teammate's job.
			const teammateJob = { cloud_identity_id: legacy.id, org_id: teamOrg, user_id: teammate };
			expect(
				await tx.select({ id: cloudIdentities.id }).from(cloudIdentities).where(claimIdentityWhere(teammateJob)),
			).toHaveLength(0);

			const statements = convertStatements();
			for (const statement of statements) await tx.execute(sql.raw(statement));
			const once = await scopes();
			expect(once.get(legacy.id)).toBe("org");
			expect(once.get(personal.id)).toBe("personal");
			expect(once.get(alreadyOrg.id)).toBe("org");

			// Idempotent: a second run matches no row.
			for (const statement of statements) {
				const result = await tx.execute(sql.raw(statement));
				expect(result.count).toBe(0);
			}
			expect(await scopes()).toEqual(once);

			// No row lost: all three are still there.
			expect(
				await tx.select({ id: cloudIdentities.id }).from(cloudIdentities).where(inArray(cloudIdentities.id, ids)),
			).toHaveLength(3);

			// After: a teammate's job in the team org is handed the converted identity …
			expect(
				await tx.select({ id: cloudIdentities.id }).from(cloudIdentities).where(claimIdentityWhere(teammateJob)),
			).toEqual([{ id: legacy.id }]);
			// … and a teammate acting in the team org may bind it (session and service token alike).
			for (const personalAuthorId of [teammate, undefined]) {
				expect(
					await tx
						.select({ id: cloudIdentities.id })
						.from(cloudIdentities)
						.where(actorIdentityWhere(legacy.id, teamOrg, personalAuthorId)),
				).toEqual([{ id: legacy.id }]);
			}
			// The true personal identity is still refused to a teammate's job.
			expect(
				await tx
					.select({ id: cloudIdentities.id })
					.from(cloudIdentities)
					.where(
						claimIdentityWhere({ cloud_identity_id: personal.id, org_id: teamOrg, user_id: teammate }),
					),
			).toHaveLength(0);

			throw new RollbackAfterAssertions();
		});

		// An assertion that fails inside the transaction rejects with its own error, rethrown here.
		let rolledBack = false;
		try {
			await run;
		} catch (error) {
			if (!(error instanceof RollbackAfterAssertions)) throw error;
			rolledBack = true;
		}
		expect(rolledBack).toBe(true);
		// The rollback took: nothing seeded here survives for another suite to see.
		const left = await getServiceDb()
			.select({ id: cloudIdentities.id })
			.from(cloudIdentities)
			.where(inArray(cloudIdentities.org_id, [teamOrg, author]));
		expect(left).toHaveLength(0);
	});
});

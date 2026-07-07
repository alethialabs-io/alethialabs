// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the TIERED support-case RLS policy (the org-owned visibility wall). Seeded via
// the service connection (bypasses RLS); read back through the RLS-enforced app connection with
// the three GUCs the policy reads — app.current_org, app.current_owner, and app.support_all.
// Proves: a member sees only cases they opened; a manage_support holder (support_all=true) sees
// the WHOLE org's cases but never another org's. This exercises the SQL policy directly; the
// PDP→support_all mapping (manage_support = owner/admin) is covered by the mocked action tests +
// the PostgresRbacPDP suite. Skips the visibility assertions when the app role isn't distinct
// from the service role (single-role dev), where RLS is a no-op.

import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb, type Tx, withScope } from "@/lib/db";
import { supportCases } from "@/lib/db/schema";
import { describeIfDb } from "./db";

const ORG = randomUUID(); // one shared org
const USER_A = randomUUID(); // member who opens caseA
const USER_B = randomUUID(); // member who opens caseB
const ORG_OTHER = randomUUID(); // a different org (isolation control)

const APP_ROLE_DISTINCT =
	(process.env.ALETHIA_APP_DATABASE_URL ?? "") !== "" &&
	process.env.ALETHIA_APP_DATABASE_URL !== process.env.ALETHIA_DATABASE_URL;

/** Scope a read to (owner, org) with the tiered support-visibility flag explicitly set. */
function withSupportAll<T>(
	ownerId: string,
	orgId: string,
	seeAll: boolean,
	fn: (tx: Tx) => Promise<T>,
): Promise<T> {
	return withScope({ ownerId, orgId }, async (tx) => {
		await tx.execute(
			sql`select set_config('app.support_all', ${seeAll ? "true" : "false"}, true)`,
		);
		return fn(tx);
	});
}

/** Minimal valid support_cases row (bypasses RLS via the service connection). */
function caseRow(userId: string, orgId: string, subject: string) {
	return {
		user_id: userId,
		org_id: orgId,
		type: "technical" as const,
		category: "other" as const,
		severity: "normal" as const,
		status: "open" as const,
		subject,
		context: {},
		contact: { notifyEmail: "req@acme.io", channel: "email" as const },
		last_author_type: "customer" as const,
	};
}

describeIfDb("support cases — tiered RLS visibility", () => {
	beforeAll(async () => {
		await getServiceDb()
			.insert(supportCases)
			.values([
				caseRow(USER_A, ORG, "A opened this"),
				caseRow(USER_B, ORG, "B opened this"),
				caseRow(USER_A, ORG_OTHER, "different org"),
			]);
	});

	afterAll(async () => {
		await getServiceDb()
			.delete(supportCases)
			.where(inArray(supportCases.org_id, [ORG, ORG_OTHER]));
	});

	it("the service connection sees every seeded case (RLS bypassed)", async () => {
		const rows = await getServiceDb()
			.select({ id: supportCases.id })
			.from(supportCases)
			.where(inArray(supportCases.org_id, [ORG, ORG_OTHER]));
		expect(rows).toHaveLength(3);
	});

	it.skipIf(!APP_ROLE_DISTINCT)(
		"a member (support_all=false) sees only the cases they opened",
		async () => {
			const aRows = await withSupportAll(USER_A, ORG, false, (tx) =>
				tx.select({ subject: supportCases.subject }).from(supportCases),
			);
			expect(aRows.map((r) => r.subject)).toEqual(["A opened this"]);

			const bRows = await withSupportAll(USER_B, ORG, false, (tx) =>
				tx.select({ subject: supportCases.subject }).from(supportCases),
			);
			expect(bRows.map((r) => r.subject)).toEqual(["B opened this"]);
		},
	);

	it.skipIf(!APP_ROLE_DISTINCT)(
		"a manage_support holder (support_all=true) sees the whole org, but never another org",
		async () => {
			const rows = await withSupportAll(USER_A, ORG, true, (tx) =>
				tx.select({ subject: supportCases.subject }).from(supportCases),
			);
			const subjects = rows.map((r) => r.subject).sort();
			expect(subjects).toEqual(["A opened this", "B opened this"]);
			// The other org's case is invisible even with support_all — org is the outer wall.
			expect(subjects).not.toContain("different org");
		},
	);

	it.skipIf(!APP_ROLE_DISTINCT)(
		"a member cannot read a teammate's case even by asking for its id",
		async () => {
			const [teammate] = await getServiceDb()
				.select({ id: supportCases.id })
				.from(supportCases)
				.where(eq(supportCases.user_id, USER_B))
				.limit(1);
			const leak = await withSupportAll(USER_A, ORG, false, (tx) =>
				tx
					.select({ id: supportCases.id })
					.from(supportCases)
					.where(eq(supportCases.id, teammate.id)),
			);
			expect(leak).toHaveLength(0);
		},
	);
});

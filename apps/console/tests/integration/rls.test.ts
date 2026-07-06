// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: row-level-security isolation — the multi-tenant blast wall. Seeded via the
// service connection (bypasses RLS); read back through the RLS-enforced app connection
// (withOwnerScope) to prove one org can never see another's rows. Skips the isolation
// assertions when the app role isn't distinct from the service role (single-role dev).

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb, withOwnerScope } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { describeIfDb } from "./db";

const ORG_A = randomUUID();
const ORG_B = randomUUID();

// The app role is only a real RLS boundary when it differs from the service role.
const APP_ROLE_DISTINCT =
	(process.env.ALETHIA_APP_DATABASE_URL ?? "") !== "" &&
	process.env.ALETHIA_APP_DATABASE_URL !== process.env.ALETHIA_DATABASE_URL;

describeIfDb("RLS tenant isolation", () => {
	beforeAll(async () => {
		await getServiceDb()
			.insert(projects)
			.values([
				{
					user_id: ORG_A,
					org_id: ORG_A,
					project_name: `a-${ORG_A.slice(0, 6)}`,
					region: "eu-west-1",
					iac_version: "1.0.0",
				},
				{
					user_id: ORG_B,
					org_id: ORG_B,
					project_name: `b-${ORG_B.slice(0, 6)}`,
					region: "eu-west-1",
					iac_version: "1.0.0",
				},
			]);
	});

	afterAll(async () => {
		await getServiceDb()
			.delete(projects)
			.where(inArray(projects.org_id, [ORG_A, ORG_B]));
	});

	it("the service connection sees both orgs' rows (RLS bypassed)", async () => {
		const rows = await getServiceDb()
			.select()
			.from(projects)
			.where(inArray(projects.org_id, [ORG_A, ORG_B]));
		expect(rows).toHaveLength(2);
	});

	it.skipIf(!APP_ROLE_DISTINCT)(
		"org A's app connection sees only org A's rows",
		async () => {
			const aRows = await withOwnerScope(ORG_A, (tx) =>
				tx.select().from(projects).where(eq(projects.org_id, ORG_A)),
			);
			expect(aRows).toHaveLength(1);

			// Org A scope must NOT be able to read org B's row, even by asking for it.
			const leak = await withOwnerScope(ORG_A, (tx) =>
				tx.select().from(projects).where(eq(projects.org_id, ORG_B)),
			);
			expect(leak).toHaveLength(0);
		},
	);
});

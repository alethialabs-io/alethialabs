// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (real Postgres): tenant-scoping RLS + the GC-aware append-only WORM on
// authz_activity_log (the PDP governance/audit log). Proves four things a mocked db can't:
//
//   1. TENANT SCOPING — as the least-privilege app role (alethia_app) with app.current_org set to
//      org A, a SELECT returns ONLY org-A rows; org-B rows are RLS-invisible.
//   2. APP-ROLE IMMUTABILITY — the app role's UPDATE / DELETE / TRUNCATE are rejected (the mutation
//      grants are REVOKEd), so the customer-request role can never tamper with the log.
//   3. SERVICE-ROLE WORM — even the BYPASSRLS service role cannot UPDATE / DELETE / TRUNCATE via a
//      raw statement (the trigger fires regardless of role) — the tamper-evidence property that RLS
//      alone (which the service role bypasses) can't give.
//   4. GC STILL PRUNES — gc_authz_activity_log flags its own txn (app.authz_gc='on') so the WORM
//      trigger permits the retention delete; a backdated row is pruned while recent rows survive.
//   5. WRITER STILL INSERTS — the append path (recordActivity → getServiceDb insert) is untouched.
//
// The app-role cases (1, 2) need a distinct alethia_app connection (ALETHIA_APP_DATABASE_URL); they
// skip in single-role dev, exactly like rls.test.ts.

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb, withOwnerScope } from "@/lib/db";
import { authzActivityLog } from "@/lib/db/schema";
import { gcAuthzActivityLog } from "@/lib/reconcile/gc";
import { describeIfDb, purgeAuthzActivityLog } from "./db";

// The app role is only a real RLS/REVOKE boundary when it differs from the service role.
const APP_ROLE_DISTINCT =
	(process.env.ALETHIA_APP_DATABASE_URL ?? "") !== "" &&
	process.env.ALETHIA_APP_DATABASE_URL !== process.env.ALETHIA_DATABASE_URL;

describeIfDb("authz_activity_log tenant-scoping RLS + GC-aware WORM", () => {
	const ORG_A = randomUUID();
	const ORG_B = randomUUID();
	const ACTOR = randomUUID();

	/** Count this org's remaining rows (via the RLS-bypassing service role). */
	async function countForOrg(orgId: string): Promise<number> {
		const [row] = await getServiceDb()
			.select({ n: sql<number>`count(*)::int` })
			.from(authzActivityLog)
			.where(eq(authzActivityLog.org_id, orgId));
		return row.n;
	}

	beforeAll(async () => {
		const db = getServiceDb();
		// Two recent org-A rows + one backdated org-A row (for the GC), and one org-B row (the
		// cross-tenant control). Seeded via the service role, which the append (INSERT) path uses.
		await db.insert(authzActivityLog).values([
			{
				org_id: ORG_A,
				actor_id: ACTOR,
				action: "project:deploy",
				resource_type: "project",
				resource_id: null,
				decision: true,
				reason: "worm-a-recent",
			},
			{
				org_id: ORG_A,
				actor_id: ACTOR,
				action: "project:view",
				resource_type: "project",
				resource_id: null,
				decision: false,
				reason: "worm-a-recent",
			},
			{
				org_id: ORG_A,
				actor_id: ACTOR,
				action: "project:destroy",
				resource_type: "project",
				resource_id: null,
				decision: true,
				reason: "worm-a-old",
				ts: sql`now() - interval '400 days'`,
			},
			{
				org_id: ORG_B,
				actor_id: ACTOR,
				action: "project:deploy",
				resource_type: "project",
				resource_id: null,
				decision: true,
				reason: "worm-b-recent",
			},
		]);
	});

	afterAll(async () => {
		// authz_activity_log is WORM-protected: teardown deletes go through the GC exemption helper.
		await purgeAuthzActivityLog(eq(authzActivityLog.org_id, ORG_A));
		await purgeAuthzActivityLog(eq(authzActivityLog.org_id, ORG_B));
	});

	// ── 1. Tenant scoping (RLS USING) — app role only ────────────────────────────
	it.skipIf(!APP_ROLE_DISTINCT)(
		"app role with app.current_org=A sees only org-A rows (org-B invisible)",
		async () => {
			// withOwnerScope(A) sets app.current_org=A; the authz_activity_select policy filters to it.
			const rows = await withOwnerScope(ORG_A, (tx) =>
				tx
					.select({ org: authzActivityLog.org_id })
					.from(authzActivityLog)
					.where(sql`${authzActivityLog.org_id} in (${ORG_A}, ${ORG_B})`),
			);
			expect(rows.length).toBeGreaterThan(0);
			expect(rows.every((r) => r.org === ORG_A)).toBe(true);

			// Explicitly asking for org B returns nothing (the wall, not just a missing filter).
			const leak = await withOwnerScope(ORG_A, (tx) =>
				tx.select().from(authzActivityLog).where(eq(authzActivityLog.org_id, ORG_B)),
			);
			expect(leak).toHaveLength(0);
		},
	);

	// ── 2. App-role immutability (REVOKE) ────────────────────────────────────────
	it.skipIf(!APP_ROLE_DISTINCT)("app role UPDATE is rejected", async () => {
		await expect(
			withOwnerScope(ORG_A, (tx) =>
				tx.execute(
					sql`update public.authz_activity_log set reason = 'tampered' where org_id = ${ORG_A}`,
				),
			),
		).rejects.toThrow();
	});

	it.skipIf(!APP_ROLE_DISTINCT)("app role DELETE is rejected", async () => {
		await expect(
			withOwnerScope(ORG_A, (tx) =>
				tx.execute(sql`delete from public.authz_activity_log where org_id = ${ORG_A}`),
			),
		).rejects.toThrow();
	});

	it.skipIf(!APP_ROLE_DISTINCT)("app role TRUNCATE is rejected", async () => {
		await expect(
			withOwnerScope(ORG_A, (tx) =>
				tx.execute(sql`truncate table public.authz_activity_log`),
			),
		).rejects.toThrow();
		// Non-vacuity: the table still has rows after the blocked truncate.
		expect(await countForOrg(ORG_A)).toBeGreaterThan(0);
	});

	// ── 3. Service-role WORM — the trigger binds even the BYPASSRLS role ──────────
	it("a raw service-role UPDATE is blocked by the WORM trigger", async () => {
		await expect(
			getServiceDb()
				.update(authzActivityLog)
				.set({ reason: "tampered" })
				.where(eq(authzActivityLog.org_id, ORG_A)),
		).rejects.toThrow();
	});

	it("a raw service-role DELETE (no GC flag) is blocked by the WORM trigger", async () => {
		await expect(
			getServiceDb().delete(authzActivityLog).where(eq(authzActivityLog.org_id, ORG_B)),
		).rejects.toThrow();
		// The row survives the blocked delete.
		expect(await countForOrg(ORG_B)).toBeGreaterThan(0);
	});

	it("a raw service-role TRUNCATE is blocked by the WORM trigger", async () => {
		await expect(
			getServiceDb().execute(sql`truncate table public.authz_activity_log`),
		).rejects.toThrow();
	});

	// ── 4. GC still prunes (the exemption path) ──────────────────────────────────
	it("the retention GC still prunes backdated rows despite the WORM", async () => {
		// The org-A backdated (400d) row exists before the GC pass.
		const [before] = await getServiceDb()
			.select({ n: sql<number>`count(*)::int` })
			.from(authzActivityLog)
			.where(and(eq(authzActivityLog.org_id, ORG_A), eq(authzActivityLog.reason, "worm-a-old")));
		expect(before.n).toBe(1);

		// The wrapper the reconcile loop calls (365d window) — the GC sets app.authz_gc='on', so the
		// WORM trigger permits the delete. Deleted count includes our old row (>=1).
		const { deleted } = await gcAuthzActivityLog(getServiceDb());
		expect(deleted).toBeGreaterThanOrEqual(1);

		// The old row is gone; the two recent org-A rows survive.
		const [after] = await getServiceDb()
			.select({ n: sql<number>`count(*)::int` })
			.from(authzActivityLog)
			.where(and(eq(authzActivityLog.org_id, ORG_A), eq(authzActivityLog.reason, "worm-a-old")));
		expect(after.n).toBe(0);
		const [recent] = await getServiceDb()
			.select({ n: sql<number>`count(*)::int` })
			.from(authzActivityLog)
			.where(
				and(eq(authzActivityLog.org_id, ORG_A), eq(authzActivityLog.reason, "worm-a-recent")),
			);
		expect(recent.n).toBe(2);
	});

	// ── 5. Writer (append) path still works ──────────────────────────────────────
	it("the writer (service role) can still INSERT — the append path is untouched", async () => {
		const marker = `worm-write-${randomUUID().slice(0, 8)}`;
		// The exact shape recordActivity() inserts, awaited so the assertion is deterministic.
		await getServiceDb().insert(authzActivityLog).values({
			org_id: ORG_A,
			actor_id: ACTOR,
			action: "runner:create",
			resource_type: "runner",
			resource_id: null,
			decision: true,
			reason: marker,
		});
		const [row] = await getServiceDb()
			.select({ id: authzActivityLog.id })
			.from(authzActivityLog)
			.where(eq(authzActivityLog.reason, marker));
		expect(row?.id).toBeDefined();
	});
});

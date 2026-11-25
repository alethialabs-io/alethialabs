// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the cases list's filters run in the paged query (#7396), against real Postgres
// under the tiered support RLS.
//
// Before #7396 the list's search, severity and type filters ran in the browser over the pages it
// had loaded, so a case past the first page could not be found until the reader paged to it. The
// case this suite seeds is the OLDEST of more than a page of cases — beyond page one by
// construction — and each filter must return it on the FIRST page. The facet counts are the
// caller's unfiltered cases, and do not move when a filter is applied.
//
// Visibility is RLS, so the read runs through the RLS-enforced app connection with the same GUCs
// `withSupportScope` sets; with a single DB role RLS is a no-op and every org's cases would be in
// view, so those assertions skip there (as in support-rls.test.ts).

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb, type Tx, withScope } from "@/lib/db";
import { supportCases } from "@/lib/db/schema";
import { decodeKeysetCursor, KEYSET_DEFAULT_LIMIT as CASE_PAGE_SIZE } from "@/lib/queries/keyset";
import { type CaseListFilter, type CasePage, queryCasesPage } from "@/lib/queries/support";
import { APP_ROLE_DISTINCT, describeIfDb } from "./db";

const ORG = randomUUID();
const USER = randomUUID();
/** A token no other suite's subject carries. */
const NEEDLE = `needle-${randomUUID().slice(0, 8)}`;
/** How many ordinary cases sit ahead of the target: more than a page. */
const AHEAD = CASE_PAGE_SIZE + 5;

let targetId: string;
let targetNumber: number;

/** The first page of the caller's list under `filter`, read as the requester (own cases). */
function firstPage(filter: CaseListFilter): Promise<CasePage> {
	return withScope({ ownerId: USER, orgId: ORG }, async (tx: Tx) => {
		await tx.execute(sql`select set_config('app.support_all', 'false', true)`);
		return queryCasesPage(tx, USER, filter, { limit: CASE_PAGE_SIZE });
	});
}

/** A support_cases row for the caller, its activity `minutesAgo` in the past. */
function caseRow(subject: string, minutesAgo: number, over: Partial<typeof supportCases.$inferInsert> = {}) {
	const at = new Date(Date.now() - minutesAgo * 60_000);
	return {
		user_id: USER,
		org_id: ORG,
		type: "technical" as const,
		category: "other" as const,
		severity: "normal" as const,
		status: "open" as const,
		subject,
		context: {},
		contact: { notifyEmail: "req@acme.io", channel: "email" as const },
		last_author_type: "customer" as const,
		last_message_at: at,
		created_at: at,
		...over,
	};
}

describeIfDb("support.cases — filters in the paged query (#7396)", () => {
	beforeAll(async () => {
		await getServiceDb()
			.insert(supportCases)
			.values(Array.from({ length: AHEAD }, (_, i) => caseRow(`ordinary case ${i}`, i + 1)));
		// The oldest case: every ordinary one has newer activity, so it is last in the list.
		const [target] = await getServiceDb()
			.insert(supportCases)
			.values(
				caseRow(`the ${NEEDLE} case`, AHEAD + 60, {
					severity: "urgent",
					type: "billing",
					status: "resolved",
				}),
			)
			.returning({ id: supportCases.id, n: supportCases.case_number });
		targetId = target.id;
		targetNumber = target.n;
	});

	afterAll(async () => {
		await getServiceDb().delete(supportCases).where(eq(supportCases.org_id, ORG));
	});

	it.skipIf(!APP_ROLE_DISTINCT)("unfiltered, the target is beyond the first page", async () => {
		const page = await firstPage({});
		expect(page.rows).toHaveLength(CASE_PAGE_SIZE);
		expect(page.rows.map((r) => r.id)).not.toContain(targetId);
	});

	it.skipIf(!APP_ROLE_DISTINCT)("following nextCursor walks every case once and ends with null", async () => {
		const first = await firstPage({});
		expect(first.universeEmpty).toBe(false);
		expect(first.nextCursor).not.toBeNull();
		const cursor = decodeKeysetCursor(first.nextCursor ?? "") ?? undefined;
		const second = await withScope({ ownerId: USER, orgId: ORG }, async (tx: Tx) => {
			await tx.execute(sql`select set_config('app.support_all', 'false', true)`);
			return queryCasesPage(tx, USER, {}, { cursor, limit: CASE_PAGE_SIZE });
		});
		// AHEAD + 1 cases in all: the second page holds the rest, ending with the target, and is the last.
		expect(second.rows).toHaveLength(AHEAD + 1 - CASE_PAGE_SIZE);
		expect(second.rows.at(-1)?.id).toBe(targetId);
		expect(second.nextCursor).toBeNull();
		const ids = [...first.rows, ...second.rows].map((r) => r.id);
		expect(new Set(ids).size).toBe(AHEAD + 1);
	});

	it.skipIf(!APP_ROLE_DISTINCT).each<[string, CaseListFilter]>([
		["severity", { severity: ["urgent"] }],
		["type", { type: ["billing"] }],
		["search by subject", { search: NEEDLE.toUpperCase() }],
		["the resolved bucket", { status: "resolved" }],
	])("a %s filter finds it on the first page", async (_name, filter) => {
		const page = await firstPage(filter);
		expect(page.rows.map((r) => r.id)).toEqual([targetId]);
	});

	it.skipIf(!APP_ROLE_DISTINCT)("search matches the CASE-000123 reference and the bare number", async () => {
		const reference = `case-${String(targetNumber).padStart(6, "0")}`;
		expect((await firstPage({ search: reference })).rows.map((r) => r.id)).toContain(targetId);
		expect((await firstPage({ search: String(targetNumber) })).rows.map((r) => r.id)).toContain(targetId);
	});

	it.skipIf(!APP_ROLE_DISTINCT)("a LIKE wildcard in the search matches literally", async () => {
		expect((await firstPage({ search: "%" })).rows).toEqual([]);
	});

	it.skipIf(!APP_ROLE_DISTINCT)("an unknown facet value drops out rather than failing the read", async () => {
		expect((await firstPage({ severity: ["bogus"] })).rows).toHaveLength(CASE_PAGE_SIZE);
	});

	it.skipIf(!APP_ROLE_DISTINCT)("facets count the caller's unfiltered cases, and do not move under a filter", async () => {
		const unfiltered = await firstPage({});
		const filtered = await firstPage({ severity: ["urgent"], search: NEEDLE });
		const bySeverity = (p: CasePage) =>
			Object.fromEntries((p.facets?.severity ?? []).map((o) => [o.value, o.count]));
		expect(bySeverity(unfiltered)).toEqual({ normal: AHEAD, urgent: 1 });
		expect(filtered.facets).toEqual(unfiltered.facets);
		const byType = Object.fromEntries((unfiltered.facets?.type ?? []).map((o) => [o.value, o.count]));
		expect(byType).toEqual({ technical: AHEAD, billing: 1 });
	});

	it.skipIf(!APP_ROLE_DISTINCT)("a later page carries no facets", async () => {
		const page = await withScope({ ownerId: USER, orgId: ORG }, async (tx: Tx) => {
			await tx.execute(sql`select set_config('app.support_all', 'false', true)`);
			return queryCasesPage(tx, USER, {}, {
				limit: CASE_PAGE_SIZE,
				cursor: { at: new Date().toISOString(), id: randomUUID() },
			});
		});
		expect(page.facets).toBeNull();
	});
});

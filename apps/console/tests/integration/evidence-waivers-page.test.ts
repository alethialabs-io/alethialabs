// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the recorded-waivers list (lib/queries/evidence.ts → queryEvidenceWaiversPage, #7488)
// against real Postgres. The waivers used to ride inside the roll-up behind `.limit(100)`, so waiver
// 101 and later were unreachable. Here the SQL itself runs:
//
//   - walking the pages returns EVERY waiver in scope exactly once, newest first — past row 100 —
//     across page boundaries that fall inside ties on the recorded instant, including rows a few
//     MICROSECONDS apart inside one millisecond (the ms truncation the cursor depends on);
//   - the in-force verdict is decided in SQL: no expiry and a future expiry are in force, a past one
//     and an expiry that does not parse are not — and the unparseable one does not fail the read;
//   - the roll-up's `waivers` holds only the in-force ones, uncapped;
//   - another org's waiver and a waiver on a project outside the visible set never appear.
//
// Seeds via the service connection (bypasses RLS) with unique ids and cleans up by those ids.

import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getServiceDb } from "@/lib/db";
import { jobs, projects } from "@/lib/db/schema";
import { type EvidenceWaiverRow, queryEvidenceWaiversPage, queryOrgEvidence } from "@/lib/queries/evidence";
import type { KeysetPosition } from "@/lib/queries/keyset";
import { decodeKeysetCursor } from "@/lib/queries/keyset";
import { describeIfDb } from "./db";

const ORG_ID = randomUUID();
const OTHER_ORG_ID = randomUUID();
const USER_ID = randomUUID();
const VISIBLE_PROJECT = randomUUID();
const HIDDEN_PROJECT = randomUUID();

/** Org-level waivers in the log: more than two pages of 50, and past the old cap of 100. */
const TOTAL = 130;

const PAST = new Date(Date.now() - 86_400_000).toISOString();
const FUTURE = new Date(Date.now() + 7 * 86_400_000).toISOString();

/**
 * Waiver `i`'s recorded instant: three waivers share each second, and within a second they sit a few
 * MICROSECONDS apart in ONE millisecond — so ties on the ms-truncated key are the norm, not the edge.
 */
function recordedAt(i: number): string {
	const second = Math.floor(i / 3);
	const micro = 123_400 + (i % 3) * 7; // .123400, .123407, .123414 — one millisecond
	const base = new Date(Date.UTC(2026, 5, 1, 0, 0, 0) + second * 1000).toISOString().slice(0, 19);
	return `${base}.${String(micro).padStart(6, "0")}Z`;
}

/** Waiver `i`'s expiry: open-ended, future, past or junk, in rotation. */
function expiryOf(i: number): string | undefined {
	return [undefined, FUTURE, PAST, "not-a-date"][i % 4];
}

const ids: string[] = Array.from({ length: TOTAL }, () => randomUUID());
const visibleProjectWaiver = randomUUID();
const hiddenProjectWaiver = randomUUID();
const otherOrgWaiver = randomUUID();
const allJobIds = [...ids, visibleProjectWaiver, hiddenProjectWaiver, otherOrgWaiver];

describeIfDb("queryEvidenceWaiversPage (recorded waivers, keyset)", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		await db.insert(projects).values(
			[VISIBLE_PROJECT, HIDDEN_PROJECT].map((id) => ({
				id,
				user_id: USER_ID,
				org_id: ORG_ID,
				project_name: `it-waivers-${id.slice(0, 6)}`,
				region: "eu-west-1",
				iac_version: "1.11.4",
			})),
		);
		await db.insert(jobs).values([
			...ids.map((id, i) => ({
				id,
				user_id: USER_ID,
				org_id: ORG_ID,
				project_id: null,
				job_type: "DEPLOY" as const,
				config_snapshot: {},
				verify_override: { controls: ["KEYLESS-001"], reason: `waiver ${i}`, by: "it@alethia.test", expiry: expiryOf(i) },
				created_at: sql`${recordedAt(i)}::timestamptz`,
			})),
			{
				id: visibleProjectWaiver,
				user_id: USER_ID,
				org_id: ORG_ID,
				project_id: VISIBLE_PROJECT,
				job_type: "DEPLOY" as const,
				config_snapshot: {},
				verify_override: { controls: ["OIDC-001"], reason: "on the visible project", by: "it@alethia.test" },
				created_at: sql`'2026-05-01T00:00:00Z'::timestamptz`,
			},
			{
				id: hiddenProjectWaiver,
				user_id: USER_ID,
				org_id: ORG_ID,
				project_id: HIDDEN_PROJECT,
				job_type: "DEPLOY" as const,
				config_snapshot: {},
				verify_override: { controls: ["OIDC-001"], reason: "on the hidden project", by: "it@alethia.test" },
			},
			{
				id: otherOrgWaiver,
				user_id: USER_ID,
				org_id: OTHER_ORG_ID,
				project_id: null,
				job_type: "DEPLOY" as const,
				config_snapshot: {},
				verify_override: { controls: ["OIDC-001"], reason: "another org", by: "it@alethia.test" },
			},
		]);
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(jobs).where(inArray(jobs.id, allJobIds));
		await db.delete(projects).where(inArray(projects.id, [VISIBLE_PROJECT, HIDDEN_PROJECT]));
	});

	/** Walks every page of 50 and returns the rows in the order the list shows them. */
	async function walk(): Promise<{ rows: EvidenceWaiverRow[]; pages: number }> {
		const rows: EvidenceWaiverRow[] = [];
		let cursor: KeysetPosition | undefined;
		let pages = 0;
		for (;;) {
			const page = await queryEvidenceWaiversPage(ORG_ID, [VISIBLE_PROJECT], { cursor, limit: 50 });
			pages += 1;
			rows.push(...page.rows);
			if (page.nextCursor === null) break;
			cursor = decodeKeysetCursor(page.nextCursor) ?? undefined;
			expect(cursor, "a minted cursor decodes").toBeDefined();
			if (pages > 10) throw new Error("the walk did not end");
		}
		return { rows, pages };
	}

	it("returns every waiver in scope exactly once, newest first, past row 100", async () => {
		const { rows, pages } = await walk();
		// 130 org-level waivers + the one on the visible project, newest first (that one is oldest).
		const expected = [...ids].reverse().concat(visibleProjectWaiver);
		expect(pages).toBe(3);
		expect(rows.map((r) => r.id)).toHaveLength(expected.length);
		expect(new Set(rows.map((r) => r.id)).size).toBe(expected.length);
		// Within one millisecond the id decides, so compare as sets per ms group, then the whole order.
		expect(rows.map((r) => r.id).sort()).toEqual([...expected].sort());
		const times = rows.map((r) => Date.parse(r.createdAt));
		expect(times).toEqual([...times].sort((a, b) => b - a));
		// Waiver 101 — the first the old `.limit(100)` read could never return — is in the walk.
		expect(rows.length).toBeGreaterThan(100);
	});

	it("orders ties on the instant by id, so a boundary inside a tie neither skips nor repeats", async () => {
		const { rows } = await walk();
		const misordered = rows.flatMap((b, i) => {
			const a = rows[i - 1];
			return a && a.createdAt === b.createdAt && !(a.id > b.id) ? [`${a.id} before ${b.id}`] : [];
		});
		expect(misordered).toEqual([]);
		// The seed makes ties the norm: most neighbours share their ms instant.
		expect(rows.filter((b, i) => rows[i - 1]?.createdAt === b.createdAt).length).toBeGreaterThan(TOTAL / 2);
	});

	it("decides the in-force verdict in SQL — and an unparseable expiry is expired, not an error", async () => {
		const { rows } = await walk();
		const byId = new Map(rows.map((r) => [r.id, r]));
		for (const [i, id] of ids.entries()) {
			const expiry = expiryOf(i);
			const active = expiry === undefined || expiry === FUTURE;
			expect(byId.get(id)?.active, `waiver ${i} (expiry ${String(expiry)})`).toBe(active);
		}
	});

	it("the roll-up's waivers are the in-force ones only, every one of them", async () => {
		const { waivers, summary } = await queryOrgEvidence(ORG_ID, [VISIBLE_PROJECT]);
		const inForce = ids.filter((_, i) => expiryOf(i) === undefined || expiryOf(i) === FUTURE);
		expect(waivers.every((w) => w.active)).toBe(true);
		expect(waivers.map((w) => w.jobId).sort()).toEqual([...inForce, visibleProjectWaiver].sort());
		expect(summary.activeWaivers).toBe(inForce.length + 1);
	});

	it("never lists another org's waiver or one on a project outside the visible set", async () => {
		const { rows } = await walk();
		const listed = new Set(rows.map((r) => r.id));
		expect(listed.has(otherOrgWaiver)).toBe(false);
		expect(listed.has(hiddenProjectWaiver)).toBe(false);
	});

	it("an org with no waivers is the universe-empty first page", async () => {
		const page = await queryEvidenceWaiversPage(randomUUID(), [], { limit: 50 });
		expect(page).toEqual({ rows: [], nextCursor: null, facets: null, universeEmpty: true });
	});
});

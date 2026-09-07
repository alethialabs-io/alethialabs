// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: GET /api/jobs — the org list is SPLIT BY CREDENTIAL (#4154), against real Postgres.
//
// cli-jobs-list-route.test.ts proves the two-element org list — `org_id in (<org>, <caller's
// personal org>)` — for a SESSION, and every actor it drives is one. This file exists because that
// list's second element means something else for a SERVICE TOKEN: `authorizeCli` builds a token's
// actor as `getActiveScope(mintingUserId, pinnedOrg)`, so `actor.userId` is the person who MINTED
// the credential, and "the caller's personal org" is a tenant the token was never pinned to. The
// route reads through `getServiceDb()`, whose role bypasses RLS, so that predicate is the entire
// tenancy boundary — and an org-T CI token was listing the minter's personal-org runner jobs.
//
// THE FIXTURE IS ONE MINTER, TWO CREDENTIALS. The same `{ userId, orgId }` actor is handed to the
// route twice, once as `session` and once as `service_token`, and the assertions are on the
// DIFFERENCE between the two answers: the row that is in one list and not the other is the
// minter's personal-org job. Holding the actor fixed is what makes that difference attributable
// to the credential rather than to the scope — a suite that used two actors would be measuring
// two scopes.
//
// Every list assertion is EXACT (`toEqual` on the sorted id set), never `toContain` /
// `not.toContain` alone. A route that returned every row in the table passes `toContain`, and a
// fixture that was never reachable passes `not.toContain`; the control at the end — a token pinned
// to the personal org itself DOES list that row — is what makes its absence under org T mean
// scoping rather than an unreachable fixture.
//
// The PDP is stubbed and the database is not. `authorizeCli` is proven in the authz suite; what is
// unproven, and what this file drives, is what the handler does with the credential it is handed.

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { z } from "zod";
import { describeIfDb } from "./db";

vi.mock("@/lib/authz/guard", () => ({
	authorizeCli: vi.fn(),
	ensureCliOrgAccess: vi.fn(),
}));
// GET never reaches these, and importing them for real drags the whole server-action graph
// (next/cache, the PDP, the billing guards) into a suite whose subject is a SELECT.
vi.mock("@/app/server/actions/projects", () => ({
	planProject: vi.fn(),
	provisionProject: vi.fn(),
	destroyProject: vi.fn(),
}));

import { GET } from "@/app/api/jobs/route";
import { authorizeCli, type CliCredential } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { jobs } from "@/lib/db/schema";

/** The org the token is pinned to, and the org the minter is scoped to as a human. */
const ORG_T = randomUUID();
/** A second org the minter also belongs to. Nothing stamped with it may appear under T. */
const ORG_OTHER = randomUUID();
/** The human who minted the token. Their personal org's id IS this id. */
const USER_MINTER = randomUUID();
/** Another member of org T. Their org-T job is the org arm, and what `?mine=true` drops. */
const USER_PEER = randomUUID();

const seededJobSchema = z.object({
	id: z.uuid(),
	org_id: z.uuid().nullable(),
	user_id: z.uuid(),
});

const bodySchema = z.object({
	jobs: z.array(z.object({ id: z.string(), user_id: z.string(), org_id: z.string().nullable() })),
	total: z.number(),
	page: z.object({
		total: z.number(),
		next_cursor: z.string().nullable(),
	}),
});
type Body = z.infer<typeof bodySchema>;

/**
 * Inserts one job and returns its id.
 *
 * `orgId === null` OMITS the column so `set_org_id_from_project` runs its fallback chain — project
 * → `app.current_org` GUC → `NEW.user_id` — which is how the pre-#3942 runner-lifecycle rows were
 * written. The first test reads the stamp back rather than trusting this comment.
 */
async function seedJob(userId: string, orgId: string | null): Promise<string> {
	const [row] = await getServiceDb()
		.insert(jobs)
		.values({
			user_id: userId,
			...(orgId === null ? {} : { org_id: orgId }),
			project_id: null,
			job_type: "PLAN",
			status: "QUEUED",
			config_snapshot: {},
		})
		.returning({ id: jobs.id });
	return row.id;
}

/** Reads a seeded row back, so an assertion can be made about what the DATABASE stored. */
async function readJob(id: string) {
	const [row] = await getServiceDb()
		.select({ id: jobs.id, org_id: jobs.org_id, user_id: jobs.user_id })
		.from(jobs)
		.where(eq(jobs.id, id));
	return seededJobSchema.parse(row);
}

/**
 * Points the stubbed guard at `actor`, verified as `credential`, for the next call.
 *
 * The actor is the same object either way — that is the premise of the file. Only the credential
 * varies, exactly as it does in production: `authorizeCli` builds both kinds of actor from the
 * same `{ sub, org }` pair and differs only in which arm produced it.
 */
function actingAs(userId: string, orgId: string, credential: CliCredential): void {
	vi.mocked(authorizeCli).mockResolvedValue({ actor: { userId, orgId }, credential });
}

/** Drives the route and parses a 200 body. Fails loudly on any other status. */
async function get(query: string): Promise<Body> {
	const res = await GET(new Request(`http://console.test/api/jobs${query}`));
	const raw: unknown = await res.json();
	if (res.status !== 200) {
		throw new Error(`expected 200, got ${res.status}: ${JSON.stringify(raw)}`);
	}
	return bodySchema.parse(raw);
}

/** The sorted id set of a page — the shape every exact assertion below is written against. */
async function idsOf(query: string): Promise<{ ids: string[]; total: number }> {
	const body = await get(query);
	// `total` is echoed off the same tuple as the rows; it may never disagree with them.
	expect(body.total).toBe(body.page.total);
	return { ids: body.jobs.map((j) => j.id).sort(), total: body.page.total };
}

/** Walks the endpoint one row at a time to exhaustion, bounded so a runaway cursor fails loudly. */
async function walkOneByOne(query: string): Promise<string[]> {
	const ids: string[] = [];
	let cursor = "";
	for (let i = 0; i < 50; i++) {
		const sep = query === "" ? "?" : `${query}&`;
		const body = await get(`${sep}limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
		ids.push(...body.jobs.map((j) => j.id));
		if (body.page.next_cursor === null) return ids;
		cursor = body.page.next_cursor;
	}
	throw new Error("walk did not exhaust in 50 pages");
}

describeIfDb("GET /api/jobs — a service token lists its pin, a session lists its pin AND its personal org (#4154)", () => {
	/** The minter's own org-T job. In every list. */
	let tMineId = "";
	/** A peer's org-T job. The org arm; `?mine=true` drops it for both credentials. */
	let tPeerId = "";
	/**
	 * THE ROW THE ISSUE IS ABOUT. Project-less and trigger-stamped `org_id = USER_MINTER` — the
	 * minter's PERSONAL org. A session scoped to T lists it (it is the caller's own tenant); a token
	 * pinned to T must not (the minter's tenants are not the token's).
	 */
	let minterPersonalId = "";
	/**
	 * The minter's job in a THIRD org they belong to. Neither credential may list it under T: for a
	 * session it is outside both elements of the list, for a token it is outside the pin. It is the
	 * row an owner arm (`user_id = actor.userId`) would have answered, kept so the narrowing here
	 * cannot be satisfied by a predicate that regressed to that shape.
	 */
	let minterOtherOrgId = "";
	let allIds: string[] = [];

	beforeAll(async () => {
		tMineId = await seedJob(USER_MINTER, ORG_T);
		tPeerId = await seedJob(USER_PEER, ORG_T);
		minterPersonalId = await seedJob(USER_MINTER, null);
		minterOtherOrgId = await seedJob(USER_MINTER, ORG_OTHER);
		allIds = [tMineId, tPeerId, minterPersonalId, minterOtherOrgId];
	});

	afterAll(async () => {
		await getServiceDb().delete(jobs).where(inArray(jobs.id, allIds));
	});

	it("the fixture's personal-org row really is stamped with the minter's id, and the others are not", async () => {
		// The premise. If the trigger ever stops stamping `NEW.user_id`, the personal row would be
		// stamped with something else and every assertion below would be about a different row.
		const personal = await readJob(minterPersonalId);
		expect(personal.org_id).toBe(USER_MINTER);
		expect(personal.org_id).not.toBe(ORG_T);
		// And the explicit stamps were NOT overwritten by the fallback, so the rows genuinely
		// differ in the column under test.
		expect((await readJob(tMineId)).org_id).toBe(ORG_T);
		expect((await readJob(minterOtherOrgId)).org_id).toBe(ORG_OTHER);
	});

	it("(a) a service token pinned to org T lists org T ONLY — never the minter's personal org", async () => {
		// THE TENANCY ASSERTION FOR #4154. `actor.userId` here is the minter, and before the split
		// the route put that id in the org list as if it were the caller's. Exactly the two org-T
		// rows, so a predicate that reached the personal org — or every org the minter belongs to —
		// changes the set rather than hiding inside a `toContain`.
		actingAs(USER_MINTER, ORG_T, "service_token");
		const { ids, total } = await idsOf("?limit=100");
		expect(ids).toEqual([tMineId, tPeerId].sort());
		expect(total).toBe(2);
	});

	it("(b) a session for the SAME actor still lists the personal-org row alongside org T", async () => {
		// The behaviour `alethia jobs list` was shipped against, and the reason this is a split
		// rather than a narrowing: a member of a Teams org still sees their pre-#3942
		// runner-lifecycle jobs, which are stamped with their personal org.
		actingAs(USER_MINTER, ORG_T, "session");
		const { ids, total } = await idsOf("?limit=100");
		expect(ids).toEqual([tMineId, tPeerId, minterPersonalId].sort());
		expect(total).toBe(3);
	});

	it("the two answers differ by EXACTLY the personal-org row, so the split is doing one thing", async () => {
		// Attributes the difference to the credential and nothing else: same actor, same query,
		// one row apart, and that row is the one the issue names.
		actingAs(USER_MINTER, ORG_T, "session");
		const session = await idsOf("?limit=100");
		actingAs(USER_MINTER, ORG_T, "service_token");
		const token = await idsOf("?limit=100");
		const onlyInSession = session.ids.filter((id) => !token.ids.includes(id));
		expect(onlyInSession).toEqual([minterPersonalId]);
		expect(token.ids.every((id) => session.ids.includes(id))).toBe(true);
		expect(session.total - token.total).toBe(1);
	});

	it("(c) ?mine=true composes onto each credential's own scope, and narrows it — never replaces it", async () => {
		// For a session, "mine" means my org-T job AND my personal-org job: the personal org is
		// inside the list, so the AND costs nothing (the #3672 property, unchanged).
		actingAs(USER_MINTER, ORG_T, "session");
		const session = await idsOf("?mine=true&limit=100");
		expect(session.ids).toEqual([tMineId, minterPersonalId].sort());
		expect(session.total).toBe(2);

		// For a token, `user_id = <minter>` ANDed onto `org_id = T` is the minter's org-T job only.
		// This is the arm that most obviously reads as "me", and "me" is exactly the wrong boundary
		// for a token: `?mine=true` must not become the way the personal-org row gets back in.
		actingAs(USER_MINTER, ORG_T, "service_token");
		const token = await idsOf("?mine=true&limit=100");
		expect(token.ids).toEqual([tMineId]);
		expect(token.total).toBe(1);
	});

	it("neither credential lists the minter's job from a THIRD org under T — in either mode", async () => {
		// An owner arm (`user_id = actor.userId`) is what would answer this row, and it is the
		// shape the session arm must not regress to while the token arm is being narrowed.
		for (const credential of ["session", "service_token"] as const) {
			actingAs(USER_MINTER, ORG_T, credential);
			for (const q of ["?limit=100", "?mine=true&limit=100"]) {
				const { ids } = await idsOf(q);
				expect(ids).not.toContain(minterOtherOrgId);
			}
		}
	});

	it("CONTROL: a token pinned to the minter's personal org DOES list that row — so its absence under T is scoping", async () => {
		// Without this, "not returned" would also be satisfied by a row nothing can see. It is also
		// the degenerate case the route names: `orgId === userId`, where `org_id = <pin>` and
		// `org_id in (<pin>, <userId>)` are the same predicate, so a token minted for a personal
		// org loses nothing to the split.
		actingAs(USER_MINTER, USER_MINTER, "service_token");
		const { ids, total } = await idsOf("?limit=100");
		expect(ids).toEqual([minterPersonalId]);
		expect(total).toBe(1);
	});

	it("a token's cursor walk stays inside the pin on every page", async () => {
		// A cursor is a new way to address rows, so it is a new way to address someone else's.
		// Walked one row at a time so the boundary is asserted on every page, not only the first.
		actingAs(USER_MINTER, ORG_T, "service_token");
		const ids = await walkOneByOne("");
		expect(new Set(ids).size).toBe(ids.length);
		expect([...ids].sort()).toEqual([tMineId, tPeerId].sort());
	});
});

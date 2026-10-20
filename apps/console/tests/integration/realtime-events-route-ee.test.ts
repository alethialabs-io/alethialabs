// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (#6115): `GET /{org}/~/events` in the ENTERPRISE edition, where the scope resolver lands
// an org address on the org itself (not the personal scope), so a stream's keys are the real org's.
// Same stubs as realtime-events-route.test.ts (session read, Terms gate, the PDP's decision); the
// membership joins, the triggers and the LISTEN are real.
//
// RUNS ONLY WHERE `@alethia/ee` LOADS — its dist is a build output (`pnpm -F @alethia/ee build`).
// The CI integration job does not build it (building it there would switch every integration file
// to the enterprise edition in auto mode), so there this file SKIPS, and says so on stderr.

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
	const previousEdition = process.env.ALETHIA_EDITION;
	process.env.ALETHIA_EDITION = "enterprise";
	return { path: "", user: "", previousEdition };
});

vi.mock("next/headers", () => ({
	headers: async () => new Headers({ "x-alethia-path": h.path }),
}));
vi.mock("@/lib/auth/owner", () => ({
	getOwnerScope: async () => ({ userId: h.user, sessionId: "it-session" }),
}));
vi.mock("@/lib/auth", () => ({
	auth: {
		api: {
			getSession: async () =>
				h.user ? { user: { id: h.user }, session: { id: "it-session" } } : null,
		},
	},
}));
vi.mock("@/lib/billing/eligibility", () => ({ hasAcceptedCurrentDocuments: async () => true }));
vi.mock("@/lib/authz", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/authz")>();
	return { ...actual, getPdp: () => ({ can: async () => ({ allowed: true }) }) };
});
vi.mock("@/lib/realtime/self-test", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/realtime/self-test")>();
	return { ...actual, startRealtimeBus: () => {} };
});

import { GET } from "@/app/(private)/[org]/~/events/route";
import { getServiceDb } from "@/lib/db";
import { jobs, member, organization, user } from "@/lib/db/schema";
import { editionState } from "@/lib/enterprise";
import { getChangeBus } from "@/lib/realtime/bus";
import { getChangeTransport } from "@/lib/realtime/index";
import { DB_UP } from "./db";

const EE = editionState().kind === "enterprise";
if (DB_UP && !EE) {
	process.stderr.write(
		"\n[integration] @alethia/ee did not load — realtime-events-route-ee.test.ts is SKIPPING. Run `pnpm -F @alethia/ee build` to run it.\n",
	);
}
// TODO(#6169): once that PR builds ee/dist in the integration job, follow
// rpc-tenancy.enterprise.test.ts — skip only when the DB is down, and assert the edition in beforeAll.
const describeIfEe = DB_UP && EE ? describe : describe.skip;

// At FILE level, so the edition is restored even when the suite below is skipped.
afterAll(() => {
	if (h.previousEdition === undefined) delete process.env.ALETHIA_EDITION;
	else process.env.ALETHIA_EDITION = h.previousEdition;
});

const ORG = randomUUID();
const OTHER_ORG = randomUUID();
const SLUG = `it-6115-ee-${ORG.slice(0, 8)}`;
const U = { member: randomUUID(), toSuspend: randomUUID(), stranger: randomUUID() };
const createdJobs: string[] = [];
const db = () => getServiceDb();

/** Opens the stream as `userId` at `path`. */
async function open(userId: string, path: string, signal?: AbortSignal): Promise<Response> {
	h.user = userId;
	h.path = path;
	return GET(new Request(`http://console.test${path}`, { headers: { cookie: "c=1" }, signal }));
}

/** Reads until `pattern` appears in what was read (or the stream ends, or `ms` pass). */
async function readUntil(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	pattern: RegExp,
	ms = 10_000,
): Promise<string> {
	const decoder = new TextDecoder();
	let text = "";
	const deadline = Date.now() + ms;
	while (!pattern.test(text) && Date.now() < deadline) {
		const next = await Promise.race([
			reader.read(),
			new Promise<null>((r) => setTimeout(() => r(null), 250)),
		]);
		if (next === null) continue;
		if (next.done) break;
		text += decoder.decode(next.value);
	}
	return text;
}

/** A project-less job written by `userId` in `orgId`. */
async function insertJob(userId: string, orgId: string): Promise<string> {
	const [row] = await db()
		.insert(jobs)
		.values({
			user_id: userId,
			org_id: orgId,
			job_type: "PLAN",
			status: "SUCCESS",
			config_snapshot: {},
		})
		.returning({ id: jobs.id });
	createdJobs.push(row.id);
	return row.id;
}

describeIfEe("GET /{org}/~/events — enterprise edition", () => {
	beforeAll(async () => {
		await db()
			.insert(user)
			.values(Object.values(U).map((id) => ({ id, email: `it-6115-ee-${id}@example.test` })));
		await db()
			.insert(organization)
			.values([
				{ id: ORG, name: SLUG, slug: SLUG },
				{ id: OTHER_ORG, name: `${SLUG}-other`, slug: `${SLUG}-other` },
			]);
		await db()
			.insert(member)
			.values([
				{ organizationId: ORG, userId: U.member, role: "viewer" },
				{ organizationId: OTHER_ORG, userId: U.member, role: "viewer" },
				{ organizationId: ORG, userId: U.toSuspend, role: "viewer" },
			]);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	afterAll(async () => {
		if (createdJobs.length) await db().delete(jobs).where(inArray(jobs.id, createdJobs));
		await db().delete(member).where(inArray(member.organizationId, [ORG, OTHER_ORG]));
		await db().delete(organization).where(inArray(organization.id, [ORG, OTHER_ORG]));
		await db().delete(user).where(inArray(user.id, Object.values(U)));
		getChangeTransport().close();
	});

	it("answers a stranger to the org with 404", async () => {
		expect((await open(U.stranger, `/${SLUG}/~/events`)).status).toBe(404);
	});

	it("hears the org's own rows, and a member's rows in ANOTHER org only on that org's stream", async () => {
		const ac = new AbortController();
		const res = await open(U.member, `/${SLUG}/~/events`, ac.signal);
		expect(res.status).toBe(200);
		const reader = res.body!.getReader();
		await readUntil(reader, /event: hello/);
		expect(await getChangeTransport().whenListening(5000)).toBe(true);

		const elsewhere = await insertJob(U.member, OTHER_ORG); // the same person, another org
		const here = await insertJob(U.member, ORG);
		const text = await readUntil(reader, new RegExp(here));
		expect(text).toContain(here);
		expect(text).not.toContain(elsewhere);
		ac.abort();
		await reader.cancel().catch(() => {});
	});

	it("ends with `revoked` within one re-auth tick of the member being suspended mid-stream", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const res = await open(U.toSuspend, `/${SLUG}/~/events`);
		expect(res.status).toBe(200);
		const reader = res.body!.getReader();
		await readUntil(reader, /event: hello/);
		await db()
			.update(member)
			.set({ status: "suspended" })
			.where(eq(member.userId, U.toSuspend));
		vi.advanceTimersByTime(60_000);
		const text = await readUntil(reader, /event: revoked/);
		expect(text).toContain('event: revoked\ndata: {"reason":"not-member"}');
		expect(getChangeBus().stats().streams).toBe(0);
	});
});

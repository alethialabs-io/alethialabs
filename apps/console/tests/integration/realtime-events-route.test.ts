// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration (#6115, ADR 0005 D3/§10): `GET /{org}/~/events` end to end against real Postgres — the
// REAL `currentActor()` + `urlScopedOrgId()` membership join at connect, the REAL membership re-check
// mid-stream, the REAL jobs triggers, and the REAL `alethia_change` LISTEN connection carrying a row
// change to the stream's bytes.
//
// What is stubbed, and why it is not under test here:
//   · the session read (`getOwnerScope`, `auth.api.getSession`) — a session row is not what this
//     proves; the user id it yields is;
//   · the Terms gate — it has its own tests, and the route's 403 for it is pinned in the unit suite;
//   · the PDP's DECISION (`getPdp().can`) — the bus's filter plumbing is what is proved, both ways,
//     against a decision fixed per project. The PDP's own answers are pdp-parity.test.ts's subject.
//
// The edition is pinned to community by configuration (#6149): `currentActor()` then lands an org
// address on the personal scope after the membership join has proved the caller belongs to the org,
// which is exactly the branch re-authorisation has to mirror.

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
	const previousEdition = process.env.ALETHIA_EDITION;
	process.env.ALETHIA_EDITION = "community";
	return { path: "", user: "", previousEdition, visibleProject: "" };
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
	return {
		...actual,
		getPdp: () => ({
			can: async (_actor: unknown, _action: string, resource: { type: string; id?: string }) => ({
				allowed: resource.type === "project" && resource.id === h.visibleProject,
			}),
		}),
	};
});
// The supervised interval is not under test; the round trip it runs is (the last case).
vi.mock("@/lib/realtime/self-test", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/realtime/self-test")>();
	return { ...actual, startRealtimeBus: () => {} };
});

import { GET } from "@/app/(private)/[org]/~/events/route";
import { getServiceDb } from "@/lib/db";
import { jobs, member, organization, projects, user } from "@/lib/db/schema";
import { getChangeBus } from "@/lib/realtime/bus";
import { getChangeTransport } from "@/lib/realtime/index";
import { selfTestOnce } from "@/lib/realtime/self-test";
import { describeIfDb } from "./db";

const ORG = randomUUID();
const SLUG = `it-6115-${ORG.slice(0, 8)}`;
const U = {
	active: randomUUID(),
	toSuspend: randomUUID(), // active at connect, suspended mid-stream
	suspended: randomUUID(),
	stranger: randomUUID(), // no member row at all
	colleague: randomUUID(), // writes jobs the active member may or may not see
};
const VISIBLE = randomUUID();
const HIDDEN = randomUUID();
const GONE = randomUUID(); // deleted mid-test: its job becomes a project-less row of the org
const createdJobs: string[] = [];
const db = () => getServiceDb();

/** Opens the stream as `userId` at `path`. */
async function open(userId: string, path: string, signal?: AbortSignal): Promise<Response> {
	h.user = userId;
	h.path = path;
	return GET(new Request(`http://console.test${path}`, { headers: { cookie: "c=1" }, signal }));
}

/** Reads until `pattern` appears in what was read (or the stream ends, or 10 s pass). */
async function readUntil(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	pattern: RegExp,
): Promise<string> {
	const decoder = new TextDecoder();
	let text = "";
	const deadline = Date.now() + 10_000;
	while (!pattern.test(text) && Date.now() < deadline) {
		const next = await Promise.race([
			reader.read(),
			new Promise<null>((r) => setTimeout(() => r(null), 500)),
		]);
		if (next === null) continue;
		if (next.done) break;
		text += decoder.decode(next.value);
	}
	return text;
}

/** A job written by `userId`, under `projectId` when given. */
async function insertJob(userId: string, projectId: string | null): Promise<string> {
	const [row] = await db()
		.insert(jobs)
		.values({
			user_id: userId,
			project_id: projectId,
			job_type: "PLAN",
			status: "SUCCESS",
			config_snapshot: {},
		})
		.returning({ id: jobs.id });
	createdJobs.push(row.id);
	return row.id;
}

describeIfDb("GET /{org}/~/events — tenancy and delivery against real Postgres", () => {
	beforeAll(async () => {
		h.visibleProject = VISIBLE;
		await db()
			.insert(user)
			.values(Object.values(U).map((id) => ({ id, email: `it-6115-${id}@example.test` })));
		await db().insert(organization).values({ id: ORG, name: SLUG, slug: SLUG });
		await db()
			.insert(member)
			.values([
				{ organizationId: ORG, userId: U.active, role: "viewer" },
				{ organizationId: ORG, userId: U.toSuspend, role: "viewer" },
				{ organizationId: ORG, userId: U.suspended, role: "viewer", status: "suspended" },
			]);
		// Community stamps an org address's work into the actor's personal scope, so the colleague's
		// projects live in the ACTIVE member's org id (= their user id) — the arm `o:` routes on.
		await db()
			.insert(projects)
			.values([
				{ id: VISIBLE, user_id: U.colleague, org_id: U.active, project_name: `v-${SLUG}`, region: "eu-central-1", iac_version: "1.9.5" },
				{ id: HIDDEN, user_id: U.colleague, org_id: U.active, project_name: `h-${SLUG}`, region: "eu-central-1", iac_version: "1.9.5" },
				{ id: GONE, user_id: U.colleague, org_id: U.active, project_name: `g-${SLUG}`, region: "eu-central-1", iac_version: "1.9.5" },
			]);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	afterAll(async () => {
		if (createdJobs.length) await db().delete(jobs).where(inArray(jobs.id, createdJobs));
		await db().delete(projects).where(inArray(projects.id, [VISIBLE, HIDDEN, GONE]));
		await db().delete(member).where(eq(member.organizationId, ORG));
		await db().delete(organization).where(eq(organization.id, ORG));
		await db().delete(user).where(inArray(user.id, Object.values(U)));
		getChangeTransport().close(); // release the test's LISTEN connection
		if (h.previousEdition === undefined) delete process.env.ALETHIA_EDITION;
		else process.env.ALETHIA_EDITION = h.previousEdition;
	});

	it("answers a stranger to the org with 404", async () => {
		const res = await open(U.stranger, `/${SLUG}/~/events`);
		expect(res.status).toBe(404);
	});

	it("answers a SUSPENDED member with 404, like a stranger", async () => {
		const res = await open(U.suspended, `/${SLUG}/~/events`);
		expect(res.status).toBe(404);
	});

	it("carries a committed job change over the real LISTEN to an active member as {t, id}", async () => {
		const ac = new AbortController();
		const res = await open(U.active, `/${SLUG}/~/events`, ac.signal);
		expect(res.status).toBe(200);
		const reader = res.body!.getReader();
		await readUntil(reader, /event: hello/);
		expect(await getChangeTransport().whenListening(5000)).toBe(true);

		const job = await insertJob(U.active, null);
		const text = await readUntil(reader, new RegExp(job));
		expect(text).toMatch(new RegExp(`event: hint\\nid: [^\\n]+\\ndata: \\{"t":"jobs","id":"${job}"\\}`));
		expect(text).not.toContain(U.active); // the routing ids never reach the wire
		ac.abort();
		await reader.cancel().catch(() => {});
	});

	it("filters the org arm through the PDP, both ways, on one stream", async () => {
		const ac = new AbortController();
		const res = await open(U.active, `/${SLUG}/~/events`, ac.signal);
		const reader = res.body!.getReader();
		await readUntil(reader, /event: hello/);
		expect(await getChangeTransport().whenListening(5000)).toBe(true);

		// A colleague's jobs reach the member only through the org arm. Hidden first: deliveries to one
		// stream keep notice order, so if the hidden one were let through it would arrive first.
		const hidden = await insertJob(U.colleague, HIDDEN);
		const visible = await insertJob(U.colleague, VISIBLE);
		const text = await readUntil(reader, new RegExp(visible));
		expect(text).toContain(visible);
		expect(text).not.toContain(hidden);
		ac.abort();
		await reader.cancel().catch(() => {});
	});

	it("delivers the org's hint for a job whose project was deleted (it is now a project-less row)", async () => {
		// The PDP stub answers "no" for GONE; once GONE no longer exists it is not asked.
		const job = await insertJob(U.colleague, GONE);
		const ac = new AbortController();
		const res = await open(U.active, `/${SLUG}/~/events`, ac.signal);
		const reader = res.body!.getReader();
		await readUntil(reader, /event: hello/);
		expect(await getChangeTransport().whenListening(5000)).toBe(true);

		await db().delete(projects).where(eq(projects.id, GONE)); // ON DELETE SET NULL → one notice, p = GONE
		const text = await readUntil(reader, new RegExp(job));
		expect(text).toContain(job);
		ac.abort();
		await reader.cancel().catch(() => {});
	});

	it("ends with `revoked` within one re-auth tick of the member being SUSPENDED mid-stream", async () => {
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
		expect((await reader.read()).done).toBe(true);
	});

	it("ends with `revoked` within one re-auth tick of the member being removed mid-stream", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const res = await open(U.active, `/${SLUG}/~/events`);
		const reader = res.body!.getReader();
		await readUntil(reader, /event: hello/);
		const before = getChangeBus().stats().streams;

		await db().delete(member).where(eq(member.userId, U.active));
		vi.advanceTimersByTime(60_000);
		const text = await readUntil(reader, /event: revoked/);
		expect(text).toContain('event: revoked\ndata: {"reason":"not-member"}');
		expect((await reader.read()).done).toBe(true);
		expect(getChangeBus().stats().streams).toBe(before - 1);
	});

	it("the self-test hears its own NOTIFY on the real LISTEN connection", async () => {
		const stats = await selfTestOnce();
		expect(stats.streams).toBe(0); // every stream above has closed: the leak counter is back to 0
	});
});

// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the three SINGLE-JOB CLI routes — `GET /api/cli/jobs/[id]`, its `logs`, and its
// `cancel` — scope on the same two orgs the LIST does, against real Postgres.
//
// THE ASYMMETRY THIS FILE EXISTS FOR (#4022). `GET /api/jobs` scopes on `org_id in (<caller's
// org>, <caller's personal org>)` and carries a long rationale for why. These three carried
// `org_id = <caller's org>` alone, and the difference was invisible while nothing NEW could be
// stamped with a personal org — the pre-#3942 rows the list's second arm recovers are history
// nobody polls. #4022 made it reachable on a fresh row: an unassigned runner-lifecycle enqueue
// resolves its stamp from the fleet that must claim it, so a Teams member on a legacy-only fleet
// gets a personal-org job. The enqueue returns 201 and every one of these three then answers 404
// — `alethia runner destroy --wait` exits 1 at `failed to poll job status` on a teardown it just
// queued, and the same job can be neither tailed nor cancelled from the terminal.
//
// WHY THIS TIER. The claim is about a WHERE clause, so a mock that returns rows regardless of the
// predicate would pass whatever the predicate said. Postgres evaluates it here.
//
// THE THIRD ROW IS THE POINT. Widening a tenancy predicate is the failure mode of the fix, so
// `strangerJobId` is seeded in an org the caller has nothing to do with and asserted 404 on all
// three routes. The boundary stays ONE COLUMN wide — an `IN` on `org_id`, never `org_id = … OR
// user_id = …`: for a service token `actor.userId` is the human who MINTED the credential, so an
// org-unbounded identity arm returns their jobs from every org they belong to through a token
// pinned to one. That is the leak `cli-jobs-list-route.test.ts` documents; this file must not
// reintroduce it one route over.
//
// The PDP is stubbed — `authorizeCli` is proven in the authz suite. The database is not, and the
// predicate it evaluates is the subject.

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { describeIfDb } from "./db";

vi.mock("@/lib/authz/guard", () => ({
	authorizeCli: vi.fn(),
	ensureCliOrgAccess: vi.fn(),
}));

import { GET as getJob } from "@/app/api/cli/jobs/[id]/route";
import { POST as cancelJob } from "@/app/api/cli/jobs/[id]/cancel/route";
import { GET as getLogs } from "@/app/api/cli/jobs/[id]/logs/route";
import { authorizeCli } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { jobs } from "@/lib/db/schema";

/** A member of a Teams org. Their personal org's id IS this value. */
const USER = randomUUID();
/** The Teams org they are acting in. */
const TEAM_ORG = randomUUID();
/** A tenant this caller has nothing to do with. */
const FOREIGN_ORG = randomUUID();
/** The human who owns the foreign job — deliberately NOT the caller. */
const FOREIGN_USER = randomUUID();

/** The job stamped with the caller's active org — the ordinary case. */
let teamJobId = "";
/** The job stamped with the caller's PERSONAL org — what #4022 can now produce. */
let personalJobId = "";
/** Another tenant's job. Must never be reachable. */
let strangerJobId = "";

/** Seeds one QUEUED job with an EXPLICIT org stamp, and returns its id. */
async function seedJob(userId: string, orgId: string): Promise<string> {
	const [row] = await getServiceDb()
		.insert(jobs)
		.values({
			user_id: userId,
			org_id: orgId,
			project_id: null,
			job_type: "DESTROY_RUNNER",
			status: "QUEUED",
			config_snapshot: {},
		})
		.returning({ id: jobs.id, org_id: jobs.org_id });
	// The stamp is the fixture's whole premise: an explicit value must survive, because
	// `set_org_id_from_project` fills only a NULL. If this ever fails, every row below is in a
	// different org than the test believes and the verdicts mean nothing.
	expect(row.org_id).toBe(orgId);
	return row.id;
}

/** Drives all three routes for one job id and returns their statuses. */
async function statuses(jobId: string): Promise<{
	get: number;
	logs: number;
	cancel: number;
}> {
	// One promise, awaited three times — that is what the Next.js `params` contract hands a
	// route, and re-creating it per call would test a shape no request produces.
	const params = Promise.resolve({ id: jobId });
	const get = await getJob(
		new Request(`https://console.local/api/cli/jobs/${jobId}`),
		{ params },
	);
	const logs = await getLogs(
		new Request(`https://console.local/api/cli/jobs/${jobId}/logs`),
		{ params },
	);
	const cancel = await cancelJob(
		new Request(`https://console.local/api/cli/jobs/${jobId}/cancel`, {
			method: "POST",
		}),
		{ params },
	);
	return { get: get.status, logs: logs.status, cancel: cancel.status };
}

describeIfDb("the single-job CLI routes scope on the caller's TWO orgs (#4022)", () => {
	beforeAll(async () => {
		teamJobId = await seedJob(USER, TEAM_ORG);
		personalJobId = await seedJob(USER, USER);
		strangerJobId = await seedJob(FOREIGN_USER, FOREIGN_ORG);
	});

	afterAll(async () => {
		await getServiceDb()
			.delete(jobs)
			.where(inArray(jobs.id, [teamJobId, personalJobId, strangerJobId]));
	});

	beforeEach(() => {
		// Re-armed per case because the last one swaps the caller. Each case that expects a 200
		// from `cancel` also re-arms its ROW to QUEUED, since cancel flips the status and a
		// second call would answer 400 for a reason that has nothing to do with tenancy.
		vi.mocked(authorizeCli).mockResolvedValue({
			actor: { userId: USER, orgId: TEAM_ORG },
		} as never);
	});

	it("answers on a job stamped with the ACTIVE org", async () => {
		await getServiceDb()
			.update(jobs)
			.set({ status: "QUEUED" })
			.where(eq(jobs.id, teamJobId));
		expect(await statuses(teamJobId)).toStrictEqual({
			get: 200,
			logs: 200,
			cancel: 200,
		});
	});

	it("answers on a job stamped with the caller's PERSONAL org", async () => {
		// The #4022 row. Before this fix all three answered 404 on it while the enqueue that
		// created it had returned 201 — a teardown that could be neither watched nor cancelled.
		await getServiceDb()
			.update(jobs)
			.set({ status: "QUEUED" })
			.where(eq(jobs.id, personalJobId));
		expect(await statuses(personalJobId)).toStrictEqual({
			get: 200,
			logs: 200,
			cancel: 200,
		});
	});

	it("still 404s another tenant's job on all three routes", async () => {
		// The control for the widening. The row exists, is QUEUED, and is therefore cancellable
		// by its own org — so a 404 here is the predicate refusing it, not the job being absent.
		expect(await statuses(strangerJobId)).toStrictEqual({
			get: 404,
			logs: 404,
			cancel: 404,
		});

		// And the refusal did not merely fail to FIND it: the row is untouched.
		const [row] = await getServiceDb()
			.select({ status: jobs.status })
			.from(jobs)
			.where(eq(jobs.id, strangerJobId));
		expect(row.status).toBe("QUEUED");
	});

	it("404s the caller's own personal-org job for a DIFFERENT caller", async () => {
		// `org_id IN (orgId, userId)` admits the caller's own id, and nobody else's. A second
		// member of the same Teams org must not reach the first member's personal-org row —
		// otherwise the second arm has widened the boundary rather than recovered a row.
		const peer = randomUUID();
		vi.mocked(authorizeCli).mockResolvedValue({
			actor: { userId: peer, orgId: TEAM_ORG },
		} as never);
		expect(await statuses(personalJobId)).toStrictEqual({
			get: 404,
			logs: 404,
			cancel: 404,
		});
	});
});

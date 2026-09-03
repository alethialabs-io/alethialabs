// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// POST /api/cli/runners/deploy re-implements the enqueue that `deployRunner()` does — it does NOT
// call the server action — so the "we only hold runner templates for AWS" gate has to be proven
// here separately. Without it, `alethia runner deploy` on a GCP identity queues a job that dies in
// the runner with "no templates for provider gcp", long after the runner row exists.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ authorizeCli: vi.fn() }));
vi.mock("@/lib/authz/runner-org", () => ({
	assertRunnerInOrg: vi.fn(),
	resolveUnassignedRunnerJobOrg: vi.fn(),
}));
vi.mock("@/lib/billing/job-quota", () => ({ assertJobQuotaAllowed: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));

import { POST } from "@/app/api/cli/runners/deploy/route";
import { authorizeCli } from "@/lib/authz/guard";
import {
	assertRunnerInOrg,
	resolveUnassignedRunnerJobOrg,
} from "@/lib/authz/runner-org";
import { assertJobQuotaAllowed } from "@/lib/billing/job-quota";
import { getServiceDb } from "@/lib/db";
import { notifyScaler } from "@/lib/scaler";

/**
 * A drizzle-ish chain whose builders return the chain and whose every `await` resolves to the
 * next seeded result-set (FIFO), so the route's sequential queries each get their own rows.
 */
function makeDb() {
	const queue: unknown[][] = [];
	const valuesSpy = vi.fn();
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		select: () => db,
		from: () => db,
		where: () => db,
		orderBy: () => db,
		limit: () => db,
		insert: () => db,
		values: (...a: unknown[]) => {
			valuesSpy(...a);
			return db;
		},
		returning: () => db,
		then: (resolve: (v: unknown) => void) =>
			resolve(queue.length ? queue.shift() : []),
	});
	return { db, queue, valuesSpy };
}

let mock: ReturnType<typeof makeDb>;

/** Builds the POST request the CLI sends for `alethia runner deploy`. */
function req(body: Record<string, unknown>): Request {
	return new Request("https://console.local/api/cli/runners/deploy", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

const DEPLOY = { name: "Cloud", cloud_identity_id: "ci-1", region: "us-east-1" };

beforeEach(() => {
	vi.clearAllMocks();
	mock = makeDb();
	vi.mocked(authorizeCli).mockResolvedValue({
		actor: { userId: "user-1", orgId: "org-1" },
	} as never);
	vi.mocked(getServiceDb).mockReturnValue(mock.db as never);
	// The default fleet resolution is "nothing to change": the resolver is proven against real
	// Postgres in the integration suite, and stubbing it to the identity here keeps every case
	// below asking about THIS route rather than about the resolver.
	vi.mocked(resolveUnassignedRunnerJobOrg).mockImplementation(
		((_db: unknown, orgId: string) => Promise.resolve(orgId)) as never,
	);
});

describe("POST /api/cli/runners/deploy", () => {
	it("queues the deploy for an AWS identity", async () => {
		mock.queue.push(
			[{ id: "ci-1", provider: "aws", org_id: "org-1" }], // identity lookup
			[{ version: "1.4.0" }], // latest release
			[{ id: "r-dep", name: "Cloud" }], // runner insert
			[{ id: "job-1", status: "QUEUED", created_at: new Date() }], // job insert
		);
		const res = await POST(req(DEPLOY));
		expect(res.status).toBe(201);

		const jobValues = mock.valuesSpy.mock.calls[1][0];
		expect(jobValues.config_snapshot).toMatchObject({
			cloud_provider: "aws",
			region: "us-east-1",
		});
		expect(notifyScaler).toHaveBeenCalledTimes(1);
	});

	// ── #3874: both inserts carry the ACTOR's org, explicitly ──────────────────────────────
	//
	// Both run on getServiceDb() — a role that bypasses RLS and sets no `app.current_org` —
	// so the set_org_id triggers fell through to `NEW.user_id` and put a Teams member's runner
	// AND its job in their personal org. They matched each other, which is why the pair worked:
	// both were wrong in the same direction. Stamping both explicitly is what makes the value
	// chosen rather than inherited from a fallback branch.
	//
	// THE REASON GIVEN HERE FOR THE PAIR AGREEING WAS WRONG, AND #4022 MOVED IT RATHER THAN
	// DELETING IT. It used to read: "`claim_next_job` compares `j.org_id = v_runner_org_id` as a
	// hard equality, so the two stamps MUST agree — by construction rather than by both falling
	// through the same branch." That equality is evaluated against the org of the runner that
	// CLAIMS the job, and the runners row this request creates is not that runner: it does not
	// exist yet, and it is the thing the job builds. So the pair agreeing is not an invariant the
	// claim predicate imposes — it is simply what both stamps come to when the caller's fleet can
	// claim their active org, which is this fixture and the overwhelmingly common case. The case
	// below is the one where they legitimately diverge; the assertion here is unchanged and its
	// value survives, but it is no longer offered as a law.
	it("stamps the runners row and the jobs row with the SAME actor org", async () => {
		mock.queue.push(
			[{ id: "ci-1", provider: "aws", org_id: "org-1" }], // identity lookup
			[{ version: "1.4.0" }], // latest release
			[{ id: "r-dep", name: "Cloud" }], // runner insert
			[{ id: "job-1", status: "QUEUED", created_at: new Date() }], // job insert
		);
		expect((await POST(req(DEPLOY))).status).toBe(201);

		const runnerValues = mock.valuesSpy.mock.calls[0][0];
		const jobValues = mock.valuesSpy.mock.calls[1][0];
		expect(runnerValues.org_id).toBe("org-1");
		expect(jobValues.org_id).toBe("org-1");
		// The pair, asserted as a pair — the equality claim_next_job evaluates.
		expect(jobValues.org_id).toBe(runnerValues.org_id);
		// And NOT the personal org the trigger would otherwise have chosen.
		expect(jobValues.org_id).not.toBe("user-1");
		expect(runnerValues.org_id).not.toBe("user-1");
	});

	// ── #4022: with NO executor named, the job's stamp comes from the FLEET ────────────────
	//
	// `alethia runner deploy` with no `--assigned-runner` queues a DEPLOY_RUNNER that some
	// EXISTING runner has to claim, and `claim_next_job` Phase B's ELSE arm repeats Phase A's
	// `j.org_id = v_runner_org_id` verbatim. A Teams member whose runners are all pre-#3874
	// therefore got a job their whole fleet was barred from — the failure #4022 reported on the
	// DESTROY_RUNNER path, on the route `assertRunnerInOrg`'s own JSDoc pairs with it.
	//
	// This is the case where the two stamps DIVERGE, and it is sound: the runners row is the
	// runner being created and keeps the forward-correct tenancy; the job row is what an
	// existing runner must match.
	it("stamps the JOB from the resolved fleet org while the runner row keeps the actor's", async () => {
		vi.mocked(resolveUnassignedRunnerJobOrg).mockResolvedValue("user-1");
		mock.queue.push(
			[{ id: "ci-1", provider: "aws", org_id: "org-1" }],
			[{ version: "1.4.0" }],
			[{ id: "r-dep", name: "Cloud" }],
			[{ id: "job-1", status: "QUEUED", created_at: new Date() }],
		);
		expect((await POST(req(DEPLOY))).status).toBe(201);

		const runnerValues = mock.valuesSpy.mock.calls[0][0];
		const jobValues = mock.valuesSpy.mock.calls[1][0];
		expect(runnerValues.org_id).toBe("org-1");
		expect(jobValues.org_id).toBe("user-1");
		// And the quota is metered against the org the row LANDS in, not the caller's active one:
		// checking one org and inserting into another measures a tenant this enqueue never joins.
		expect(assertJobQuotaAllowed).toHaveBeenCalledWith("user-1");
	});

	it("does NOT consult the fleet when an executor is named", async () => {
		mock.queue.push(
			[{ id: "ci-1", provider: "aws", org_id: "org-1" }],
			[{ version: "1.4.0" }],
			[{ id: "r-dep", name: "Cloud" }],
			[{ id: "job-1", status: "QUEUED", created_at: new Date() }],
		);
		expect(
			(await POST(req({ ...DEPLOY, assigned_runner_id: "runner-x" }))).status,
		).toBe(201);
		// A named executor was validated against `actor.orgId` above, so THAT is the equality
		// that has to hold. Resolving from the fleet as well could pick a different org and
		// strand a job on its own pinned runner.
		expect(resolveUnassignedRunnerJobOrg).not.toHaveBeenCalled();
		expect(mock.valuesSpy.mock.calls[1][0].org_id).toBe("org-1");
	});

	// The transitional personal-org admission #3874 added to assertRunnerInOrg is deliberately
	// NOT taken here: on the ASSIGNED path this job is stamped `actor.orgId`, so admitting a
	// personal-org runner as its executor would queue a job whose org can never equal its
	// runner's — QUEUED forever.
	it("validates an assigned runner STRICTLY (no personal-org admission)", async () => {
		mock.queue.push(
			[{ id: "ci-1", provider: "aws", org_id: "org-1" }],
			[{ version: "1.4.0" }],
			[{ id: "r-dep", name: "Cloud" }],
			[{ id: "job-1", status: "QUEUED", created_at: new Date() }],
		);
		expect(
			(await POST(req({ ...DEPLOY, assigned_runner_id: "runner-x" }))).status,
		).toBe(201);

		// Three arguments, not four: the fourth is the personal-org allowance.
		expect(assertRunnerInOrg).toHaveBeenCalledWith(
			expect.anything(),
			"runner-x",
			"org-1",
		);
	});

	it("400s a cloud with no runner template, before inserting anything", async () => {
		mock.queue.push([{ id: "ci-1", provider: "gcp", org_id: "org-1" }]);
		const res = await POST(req({ ...DEPLOY, region: "europe-west1" }));
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/deployed runners are AWS only/i);
		// No orphan runners row, no job, no scaler wake.
		expect(mock.valuesSpy).not.toHaveBeenCalled();
		expect(notifyScaler).not.toHaveBeenCalled();
	});

	it("404s a missing identity rather than deploying to a default cloud", async () => {
		mock.queue.push([]);
		const res = await POST(req(DEPLOY));
		expect(res.status).toBe(404);
		expect(mock.valuesSpy).not.toHaveBeenCalled();
	});

	// The quota assert used to run BETWEEN the runners insert and the jobs insert, so an
	// over-quota `alethia runner deploy` left a `provisioning=deployed` runners row holding a
	// live token_hash with no job to build it — an orphan the user can see and cannot use.
	// deployRunner() has always asserted before its inserts; this proves the route now matches.
	it("rejects an over-quota deploy without inserting a runner row", async () => {
		mock.queue.push(
			[{ id: "ci-1", provider: "aws", org_id: "org-1" }], // identity lookup
			[{ version: "1.4.0" }], // latest release (must not be reached)
			[{ id: "r-dep", name: "Cloud" }], // runner insert (must not be reached)
		);
		vi.mocked(assertJobQuotaAllowed).mockRejectedValueOnce(
			new Error("Monthly job quota exceeded"),
		);

		const res = await POST(req(DEPLOY));
		expect(res.status).toBe(500);
		expect((await res.json()).error).toMatch(/quota/i);
		expect(mock.valuesSpy).not.toHaveBeenCalled();
		expect(notifyScaler).not.toHaveBeenCalled();
	});

	// Ordering, stated directly: the quota gate is consulted before the first write, not after.
	it("asserts the quota before any insert on the happy path", async () => {
		const order: string[] = [];
		vi.mocked(assertJobQuotaAllowed).mockImplementationOnce(async () => {
			order.push("quota");
		});
		mock.valuesSpy.mockImplementation(() => {
			order.push("insert");
		});
		mock.queue.push(
			[{ id: "ci-1", provider: "aws", org_id: "org-1" }],
			[{ version: "1.4.0" }],
			[{ id: "r-dep", name: "Cloud" }],
			[{ id: "job-1", status: "QUEUED", created_at: new Date() }],
		);

		expect((await POST(req(DEPLOY))).status).toBe(201);
		expect(order).toEqual(["quota", "insert", "insert"]);
	});
});

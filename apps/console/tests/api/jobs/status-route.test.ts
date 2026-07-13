// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Pins the orphan-risk signal on PUT /api/jobs/[id]/status: a FAILED terminal caused by a
// NON-cancel mid-apply interruption (the runner's 2h deadline or a shutdown-drain SIGKILL)
// arrives with execution_metadata.orphan_risk===true, and the route must raise the distinct
// `system.project.orphan_risk` critical alert (mirroring the CANCELLED path). A plain FAILED
// without that flag must NOT raise it (no over-alerting).

import { inspect } from "node:util";
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const verifyRunnerToken = vi.fn();
vi.mock("@/lib/runners/auth", () => ({
	verifyRunnerToken: (req: Request) => verifyRunnerToken(req),
}));

vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
import { getServiceDb } from "@/lib/db";

const emitAlertEventSafe = vi.fn();
vi.mock("@/lib/alerts/emit", () => ({
	emitAlertEventSafe: (...args: unknown[]) => emitAlertEventSafe(...args),
}));

vi.mock("@/lib/billing/meter", () => ({
	reportJobUsageOnce: vi.fn().mockResolvedValue(undefined),
}));

/**
 * Builds a drizzle-ish stub: `execute()` resolves the update_job_status RPC row, and the
 * select chain resolves the re-SELECTed job row the route reads execution_metadata from.
 * Returns the captured `execute` args so tests can assert on what reached the RPC.
 */
function mockDb(applied: boolean, job: Record<string, unknown> | undefined) {
	const executeCalls: unknown[] = [];
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		execute: (q: unknown) => {
			executeCalls.push(q);
			return Promise.resolve([{ applied }]);
		},
		select: () => db,
		from: () => db,
		where: () => db,
		limit: () => Promise.resolve(job ? [job] : []),
	});
	vi.mocked(getServiceDb).mockReturnValue(db as never);
	return { executeCalls };
}

/** Invokes the PUT route with a JSON body. */
async function put(jobId: string, body: unknown) {
	const { PUT } = await import("@/app/api/jobs/[id]/status/route");
	return PUT(
		new Request(`https://console.local/api/jobs/${jobId}/status`, {
			method: "PUT",
			body: JSON.stringify(body),
		}),
		{ params: Promise.resolve({ id: jobId }) },
	);
}

/** A DEPLOY job with no environment_id, so env/promotion side-effects are skipped. */
function deployJob(
	execution_metadata: Record<string, unknown> | null,
): Record<string, unknown> {
	return {
		job_type: "DEPLOY",
		project_id: "proj-1",
		environment_id: null,
		org_id: "org-1",
		cloud_identity_id: null,
		execution_metadata,
		provider: "aws",
		traceparent: null,
		created_at: new Date(),
		claimed_at: new Date(),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	verifyRunnerToken.mockResolvedValue({
		runnerId: "11111111-1111-1111-1111-111111111111",
		tokenHash: "h",
		error: null,
	});
});

describe("PUT /api/jobs/[id]/status — orphan_risk on interrupted apply", () => {
	it("propagates the 401 from runner auth", async () => {
		verifyRunnerToken.mockResolvedValue({
			runnerId: "",
			tokenHash: "",
			error: NextResponse.json({ error: "unauth" }, { status: 401 }),
		});
		expect((await put("job-1", { status: "FAILED" })).status).toBe(401);
	});

	it("raises system.project.orphan_risk on FAILED when orphan_risk===true", async () => {
		mockDb(true, deployJob({ orphan_risk: true }));

		const res = await put("job-1", {
			status: "FAILED",
			error_message: "killed",
			execution_metadata: { orphan_risk: true },
		});
		expect(res.status).toBe(200);

		const types = emitAlertEventSafe.mock.calls.map((c) => c[1]);
		expect(types).toContain("system.job.failed");
		expect(types).toContain("system.project.orphan_risk");

		const orphanCall = emitAlertEventSafe.mock.calls.find(
			(c) => c[1] === "system.project.orphan_risk",
		);
		expect(orphanCall?.[0]).toBe("org-1");
		expect(orphanCall?.[2]).toMatchObject({
			severity: "critical",
			job_id: "job-1",
			job_type: "DEPLOY",
			project_id: "proj-1",
		});
	});

	it("does NOT raise orphan_risk on a plain FAILED without the flag", async () => {
		mockDb(true, deployJob(null));

		const res = await put("job-2", {
			status: "FAILED",
			error_message: "boom",
		});
		expect(res.status).toBe(200);

		const types = emitAlertEventSafe.mock.calls.map((c) => c[1]);
		expect(types).toContain("system.job.failed");
		expect(types).not.toContain("system.project.orphan_risk");
	});

	it("skips all side-effects when the RPC was a no-op (job already terminal)", async () => {
		mockDb(false, deployJob({ orphan_risk: true }));

		const res = await put("job-3", {
			status: "FAILED",
			execution_metadata: { orphan_risk: true },
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ applied: false });
		expect(emitAlertEventSafe).not.toHaveBeenCalled();
	});
});

// Security regression (SOC 2 CC6.7): the console must scrub runner-posted execution_metadata
// at ITS OWN trust boundary before the update_job_status RPC merges it into jobs. A legacy /
// mid-rollout / self-registered runner (the runner is separately versioned) can post the
// pre-fix `argocd_admin_password` plaintext — the route must drop it so it NEVER reaches the
// DB, while non-secret metadata flows through untouched.
describe("PUT /api/jobs/[id]/status — ingest-side secret scrub", () => {
	const SENTINEL = "SENTINEL-CRED-52b90c7e-DO-NOT-PERSIST";

	/** Serializes everything that reached db.execute (the drizzle sql object incl. params). */
	function persistedSurface(executeCalls: unknown[]): string {
		return inspect(executeCalls, { depth: null });
	}

	it("drops a legacy runner's argocd_admin_password before the RPC", async () => {
		const { executeCalls } = mockDb(true, deployJob(null));

		const res = await put("job-4", {
			status: "SUCCESS",
			execution_metadata: {
				cluster_name: "prod-eks",
				argocd_url: "https://argocd.example.com",
				argocd_admin_password: SENTINEL,
				outputs: { kubeconfig: SENTINEL, eks_cluster_endpoint: "https://abc" },
			},
		});
		expect(res.status).toBe(200);

		const surface = persistedSurface(executeCalls);
		// Non-vacuity: the RPC really received the metadata JSON (non-secrets present)…
		expect(surface).toContain("argocd_url");
		expect(surface).toContain("eks_cluster_endpoint");
		// …but no planted credential crossed into it.
		expect(surface).not.toContain(SENTINEL);
		expect(surface).not.toContain("argocd_admin_password");
		expect(surface).not.toContain("kubeconfig");
	});

	it("leaves a PLAN post's plan_result payload untouched (raw plan keys legitimately collide)", async () => {
		const { executeCalls } = mockDb(true, deployJob(null));

		const res = await put("job-5", {
			status: "PROCESSING",
			execution_metadata: {
				plan_completed: true,
				plan_result: {
					resource_changes: [
						{ address: "aws_db_instance.main", change: { after_unknown: { password: true } } },
					],
				},
			},
		});
		expect(res.status).toBe(200);

		// The raw plan's attribute key named `password` survives inside plan_result — the
		// opaque-subtree exemption keeps the Plan tab rendering intact.
		expect(persistedSurface(executeCalls)).toContain("password");
	});
});

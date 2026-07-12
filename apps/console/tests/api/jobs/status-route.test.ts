// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Pins the orphan-risk signal on PUT /api/jobs/[id]/status: a FAILED terminal caused by a
// NON-cancel mid-apply interruption (the runner's 2h deadline or a shutdown-drain SIGKILL)
// arrives with execution_metadata.orphan_risk===true, and the route must raise the distinct
// `system.project.orphan_risk` critical alert (mirroring the CANCELLED path). A plain FAILED
// without that flag must NOT raise it (no over-alerting).

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
 */
function mockDb(applied: boolean, job: Record<string, unknown> | undefined) {
	const db: Record<string, unknown> = {};
	Object.assign(db, {
		execute: () => Promise.resolve([{ applied }]),
		select: () => db,
		from: () => db,
		where: () => db,
		limit: () => Promise.resolve(job ? [job] : []),
	});
	vi.mocked(getServiceDb).mockReturnValue(db as never);
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

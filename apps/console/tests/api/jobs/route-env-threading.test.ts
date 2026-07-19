// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Pins #837's edge wiring: POST /api/jobs must ACCEPT an `environment_id` and thread it into the
// placement-aware server actions (planProject / provisionProject / destroyProject), so the CLI can
// target any environment on its Fabric — not just the project's default. Omitting `environment_id`
// must pass `null` so the actions fall back to the default env (unchanged back-compat). Here the
// action module is MOCKED (unlike route.test.ts, whose real actions + no-op mock `.where()` cannot
// distinguish the default path from an explicit one), so we assert the exact forwarded argument.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/server/actions/projects", () => ({
	planProject: vi.fn(),
	provisionProject: vi.fn(),
	destroyProject: vi.fn(),
}));
vi.mock("@/lib/authz/actor-context", () => ({
	// Run the delegated action inline under a passthrough actor.
	runWithActor: vi.fn((_actor: unknown, fn: () => unknown) => fn()),
}));
vi.mock("@/lib/auth/scope", () => ({ getActiveScope: vi.fn() }));
vi.mock("@/lib/authz/guard", () => ({ ensureCliOrgAccess: vi.fn() }));
vi.mock("@/lib/cli/auth", () => ({ verifyCliToken: vi.fn() }));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));
vi.mock("@/lib/alerts/emit", () => ({ emitAlertEventSafe: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));

import { POST } from "@/app/api/jobs/route";
import {
	destroyProject,
	planProject,
	provisionProject,
} from "@/app/server/actions/projects";
import { getActiveScope } from "@/lib/auth/scope";
import { ensureCliOrgAccess } from "@/lib/authz/guard";
import { verifyCliToken } from "@/lib/cli/auth";
import { getServiceDb } from "@/lib/db";
import { makeJob } from "../../fixtures/jobs";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const PROJECT_ID = "44444444-4444-4444-8444-444444444444";
const ENV_ID = "55555555-5555-4555-8555-555555555555";

/** getServiceDb stub for the route's post-action job fetch + configuration_hash write. */
function mockServiceDb() {
	const job = makeJob({ id: JOB_ID, user_id: USER_ID, project_id: PROJECT_ID });
	const db = {
		select: () => ({
			from: () => ({ where: () => ({ limit: () => Promise.resolve([job]) }) }),
		}),
		update: () => ({
			set: () => ({ where: () => ({ returning: () => Promise.resolve([job]) }) }),
		}),
	};
	vi.mocked(getServiceDb).mockReturnValue(db as never);
}

function post(body: Record<string, unknown>) {
	return POST(
		new Request("https://console.local/api/jobs", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(verifyCliToken).mockResolvedValue({
		payload: { sub: "user-1" },
		error: null,
	} as never);
	vi.mocked(getActiveScope).mockResolvedValue({
		userId: "user-1",
		orgId: "org-1",
	} as never);
	vi.mocked(ensureCliOrgAccess).mockResolvedValue(null);
	vi.mocked(planProject).mockResolvedValue({ jobId: "job-1" } as never);
	vi.mocked(provisionProject).mockResolvedValue({ jobId: "job-1" } as never);
	vi.mocked(destroyProject).mockResolvedValue({ jobId: "job-1" } as never);
	mockServiceDb();
});

describe("POST /api/jobs — environment_id threading (#837)", () => {
	it("forwards environment_id to planProject (PLAN)", async () => {
		const res = await post({
			job_type: "PLAN",
			configuration_id: PROJECT_ID,
			environment_id: ENV_ID,
			assigned_runner_id: "runner-9",
		});
		expect(res.status).toBe(201);
		// planProject(projectId, runnerId, environmentId)
		expect(planProject).toHaveBeenCalledWith(PROJECT_ID, "runner-9", ENV_ID);
	});

	it("forwards environment_id to provisionProject (DEPLOY), preserving plan_job_id", async () => {
		const res = await post({
			job_type: "DEPLOY",
			configuration_id: PROJECT_ID,
			environment_id: ENV_ID,
			plan_job_id: "plan-3",
		});
		expect(res.status).toBe(201);
		// provisionProject(projectId, planJobId, runnerId, environmentId)
		expect(provisionProject).toHaveBeenCalledWith(PROJECT_ID, "plan-3", null, ENV_ID);
	});

	it("forwards environment_id to destroyProject (DESTROY)", async () => {
		const res = await post({
			job_type: "DESTROY",
			configuration_id: PROJECT_ID,
			environment_id: ENV_ID,
		});
		expect(res.status).toBe(201);
		// destroyProject(projectId, environmentId, runnerId)
		expect(destroyProject).toHaveBeenCalledWith(PROJECT_ID, ENV_ID, null);
	});

	it("passes null when environment_id is omitted, so the action falls back to the default env", async () => {
		const res = await post({ job_type: "PLAN", configuration_id: PROJECT_ID });
		expect(res.status).toBe(201);
		expect(planProject).toHaveBeenCalledWith(PROJECT_ID, null, null);
	});
});

// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// #5249: POST /api/jobs is the CLI's door to destroyProject. It must
//   - answer a destroy REFUSED because the Fabric still hosts live tenants with a 409 that names them
//     (the CLI prints the server's message; a client can also render `tenants` without parsing it);
//   - pass `cascade` through ONLY when the body says exactly `true` — a teardown is not opted into by
//     a truthy string;
//   - report every job a cascade queued, in destroy order, next to the TARGET's `job` (so a client
//     that reads only `job` still waits on the owner), and keep a plain destroy's body unchanged.
//
// The action is mocked so this pins the ROUTE alone; the refusal and the queueing are pinned on the
// action in tests/actions/projects.test.ts, and the claim-time order in the integration suite.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/server/actions/projects", () => ({
	planProject: vi.fn(),
	provisionProject: vi.fn(),
	destroyProject: vi.fn(),
}));
vi.mock("@/lib/authz/actor-context", () => ({
	runWithActor: vi.fn((_actor: unknown, fn: () => unknown) => fn()),
}));
vi.mock("@/lib/auth/scope", () => ({ getActiveScope: vi.fn() }));
vi.mock("@/lib/authz/guard", () => ({ ensureCliOrgAccess: vi.fn() }));
vi.mock("@/lib/cli/auth", () => ({ verifyCliToken: vi.fn() }));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));
vi.mock("@/lib/alerts/emit", () => ({ emitAlertEventSafe: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));

import { POST } from "@/app/api/jobs/route";
import { destroyProject } from "@/app/server/actions/projects";
import { emitAlertEventSafe } from "@/lib/alerts/emit";
import { getActiveScope } from "@/lib/auth/scope";
import { ensureCliOrgAccess } from "@/lib/authz/guard";
import { verifyCliToken } from "@/lib/cli/auth";
import { getServiceDb } from "@/lib/db";
import { FabricHasLiveTenantsError } from "@/lib/queries/destroy-tree";
import { makeJob } from "../../fixtures/jobs";

const PROJECT_ID = "44444444-4444-4444-8444-444444444444";
const OWNER_ENV = "55555555-5555-4555-8555-555555555555";
const NS_ENV = "66666666-6666-4666-8666-666666666666";
const OWNER_JOB = "11111111-1111-4111-8111-111111111111";
const NS_JOB = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "77777777-7777-4777-8777-777777777777";

/** getServiceDb stub for the route's post-action job fetch + configuration_hash write. */
function mockServiceDb() {
	const job = makeJob({ id: OWNER_JOB, user_id: ORG_ID, project_id: PROJECT_ID, job_type: "DESTROY", org_id: ORG_ID });
	vi.mocked(getServiceDb).mockReturnValue({
		select: () => ({
			from: () => ({ where: () => ({ limit: () => Promise.resolve([job]) }) }),
		}),
		update: () => ({
			set: () => ({ where: () => ({ returning: () => Promise.resolve([job]) }) }),
		}),
	} as never);
}

/** POSTs a CLI enqueue body to the route under test. */
function post(body: Record<string, unknown>) {
	return POST(
		new Request("https://console.local/api/jobs", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
}

const tenant = {
	id: NS_ENV,
	name: "dev-1",
	project_id: PROJECT_ID,
	fabric_id: "fab-1",
	placement_mode: "namespace" as const,
	status: "ACTIVE" as const,
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(verifyCliToken).mockResolvedValue({
		payload: { sub: "user-1" },
		error: null,
	} as never);
	vi.mocked(getActiveScope).mockResolvedValue({ userId: "user-1", orgId: "org-1" } as never);
	vi.mocked(ensureCliOrgAccess).mockResolvedValue(null);
	mockServiceDb();
});

describe("POST /api/jobs — DESTROY of a Fabric owner (#5249)", () => {
	it("answers a refusal with 409, the action's message, and the tenants by name", async () => {
		const refusal = new FabricHasLiveTenantsError("prod", [tenant]);
		vi.mocked(destroyProject).mockRejectedValue(refusal);

		const res = await post({ job_type: "DESTROY", configuration_id: PROJECT_ID, environment_id: OWNER_ENV });

		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({
			error: refusal.message,
			tenants: [{ environment_id: NS_ENV, name: "dev-1", placement_mode: "namespace", status: "ACTIVE" }],
		});
		expect(refusal.message).toContain("dev-1 (namespace, ACTIVE)");
	});

	it.each([
		[true, true],
		["true", false],
		[1, false],
		[undefined, false],
	])("cascade: %j in the body is forwarded as cascade: %s", async (given, forwarded) => {
		vi.mocked(destroyProject).mockResolvedValue({
			jobId: OWNER_JOB,
			jobs: [{ jobId: OWNER_JOB, environmentId: OWNER_ENV, name: "prod" }],
		});
		await post({ job_type: "DESTROY", configuration_id: PROJECT_ID, environment_id: OWNER_ENV, cascade: given });
		expect(destroyProject).toHaveBeenCalledWith(PROJECT_ID, OWNER_ENV, null, { cascade: forwarded });
	});

	it("reports every cascaded job in destroy order next to the owner's job, and says so in the alert", async () => {
		vi.mocked(destroyProject).mockResolvedValue({
			jobId: OWNER_JOB,
			jobs: [
				{ jobId: NS_JOB, environmentId: NS_ENV, name: "dev-1" },
				{ jobId: OWNER_JOB, environmentId: OWNER_ENV, name: "prod" },
			],
		});

		const res = await post({ job_type: "DESTROY", configuration_id: PROJECT_ID, environment_id: OWNER_ENV, cascade: true });

		expect(res.status).toBe(201);
		const body = (await res.json()) as { job: { id: string }; cascade_jobs?: unknown };
		expect(body.job.id).toBe(OWNER_JOB);
		expect(body.cascade_jobs).toEqual([
			{ job_id: NS_JOB, environment_id: NS_ENV, name: "dev-1" },
			{ job_id: OWNER_JOB, environment_id: OWNER_ENV, name: "prod" },
		]);
		expect(emitAlertEventSafe).toHaveBeenCalledWith(
			ORG_ID,
			"system.job.destroy_requested",
			expect.objectContaining({ summary: "Cascade destroy of 2 environments: dev-1, prod" }),
		);
	});

	it("keeps a plain destroy's response body unchanged — no cascade_jobs key", async () => {
		vi.mocked(destroyProject).mockResolvedValue({
			jobId: OWNER_JOB,
			jobs: [{ jobId: OWNER_JOB, environmentId: OWNER_ENV, name: "prod" }],
		});
		const res = await post({ job_type: "DESTROY", configuration_id: PROJECT_ID, environment_id: OWNER_ENV });
		expect(res.status).toBe(201);
		expect(Object.keys((await res.json()) as object)).toEqual(["job"]);
	});
});

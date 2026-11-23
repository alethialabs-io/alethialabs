// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// What POST /api/jobs hands the actions that queue an apply or a destroy, so that they can ask
// `requireApplyAuthorization` (lib/approvals/types.ts) about the caller:
//
//   · the KIND of credential, bound on the actor: a device login is `cli_session`, not `session`;
//   · the approval the request presents (`approval_id`), when it presents one;
//   · and, coming back, a refusal as a 403 with a `code`.
//
// The action module is MOCKED, as in route-env-threading.test.ts, so the exact arguments can be
// asserted. Whether the actions then ask is tests/lib/approvals/apply-authorization.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/server/actions/projects", () => ({
	planProject: vi.fn(),
	provisionProject: vi.fn(),
	destroyProject: vi.fn(),
}));
vi.mock("@/lib/authz/actor-context", () => ({
	// Run the delegated action inline; the actor it was handed is what the tests read.
	runWithActor: vi.fn((_actor: unknown, fn: () => unknown) => fn()),
}));
vi.mock("@/lib/auth/scope", () => ({ getActiveScope: vi.fn() }));
vi.mock("@/lib/authz/guard", async (importOriginal) => ({
	ensureCliOrgAccess: vi.fn(),
	assertMintingProfileStillMember: vi.fn(),
	// Real: the service token's limit is attached to the actor the actions run as.
	withServiceTokenCeiling: (await importOriginal<typeof import("@/lib/authz/guard")>()).withServiceTokenCeiling,
}));
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
import { ApplyAuthorizationError } from "@/lib/approvals/types";
import { getActiveScope } from "@/lib/auth/scope";
import { runWithActor } from "@/lib/authz/actor-context";
import { assertMintingProfileStillMember, ensureCliOrgAccess } from "@/lib/authz/guard";
import { verifyCliToken } from "@/lib/cli/auth";
import { getServiceDb } from "@/lib/db";
import { makeJob } from "../../fixtures/jobs";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const PROJECT_ID = "44444444-4444-4444-8444-444444444444";
const ENV_ID = "55555555-5555-4555-8555-555555555555";
const APPROVAL_ID = "66666666-6666-4666-8666-666666666666";

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

/** Makes the verified token a device login (no pin) or a service token pinned to `org-1`. */
function callerIs(kind: "device_login" | "service_token") {
	vi.mocked(verifyCliToken).mockResolvedValue({
		payload:
			kind === "service_token"
				? {
						sub: "user-1",
						service_token_org_id: "org-1",
						service_token_id: "st-1",
						service_token_scopes: ["read", "design", "plan", "apply", "destroy"],
						service_token_project_ids: null,
					}
				: { sub: "user-1" },
		error: null,
	} as never);
}

beforeEach(() => {
	vi.clearAllMocks();
	callerIs("device_login");
	vi.mocked(getActiveScope).mockResolvedValue({ userId: "user-1", orgId: "org-1" } as never);
	vi.mocked(ensureCliOrgAccess).mockResolvedValue(null);
	vi.mocked(assertMintingProfileStillMember).mockResolvedValue(null);
	vi.mocked(planProject).mockResolvedValue({ jobId: "job-1" } as never);
	vi.mocked(provisionProject).mockResolvedValue({ jobId: "job-1" } as never);
	vi.mocked(destroyProject).mockResolvedValue({
		jobId: "job-1",
		jobs: [{ jobId: "job-1", environmentId: ENV_ID, name: "prod" }],
	});
	mockServiceDb();
});

describe("POST /api/jobs — the credential kind bound on the actor", () => {
	it.each(["DEPLOY", "DESTROY", "PLAN"] as const)(
		"binds a device login as cli_session for %s, never as session",
		async (job_type) => {
			const res = await post({ job_type, configuration_id: PROJECT_ID });
			expect(res.status).toBe(201);
			expect(runWithActor).toHaveBeenCalledTimes(1);
			expect(runWithActor).toHaveBeenCalledWith(
				{ userId: "user-1", orgId: "org-1", credential: "cli_session" },
				expect.any(Function),
			);
		},
	);

	it.each(["DEPLOY", "DESTROY"] as const)("binds a service token as service_token for %s", async (job_type) => {
		callerIs("service_token");
		const res = await post({ job_type, configuration_id: PROJECT_ID });
		expect(res.status).toBe(201);
		expect(runWithActor).toHaveBeenCalledWith(
			{
				userId: "user-1",
				orgId: "org-1",
				credential: "service_token",
				// The token's limit rides on the actor, so every decision the action asks is held to it.
				ceiling: { scopes: ["read", "design", "plan", "apply", "destroy"], projectIds: null },
			},
			expect.any(Function),
		);
	});
});

describe("POST /api/jobs — the approval a request presents", () => {
	it("hands approval_id to provisionProject as its sixth argument (DEPLOY)", async () => {
		const res = await post({
			job_type: "DEPLOY",
			configuration_id: PROJECT_ID,
			environment_id: ENV_ID,
			plan_job_id: "plan-3",
			approval_id: APPROVAL_ID,
		});
		expect(res.status).toBe(201);
		// provisionProject(projectId, planJobId, runnerId, environmentId, approvalKey, approvalId)
		expect(provisionProject).toHaveBeenCalledWith(PROJECT_ID, "plan-3", null, ENV_ID, null, APPROVAL_ID);
	});

	it("hands approval_id to destroyProject in its options (DESTROY)", async () => {
		const res = await post({
			job_type: "DESTROY",
			configuration_id: PROJECT_ID,
			environment_id: ENV_ID,
			approval_id: APPROVAL_ID,
		});
		expect(res.status).toBe(201);
		expect(destroyProject).toHaveBeenCalledWith(PROJECT_ID, ENV_ID, null, {
			cascade: false,
			approvalId: APPROVAL_ID,
		});
	});

	it("calls the actions exactly as before when approval_id is absent or null", async () => {
		await post({ job_type: "DEPLOY", configuration_id: PROJECT_ID, approval_id: null });
		expect(provisionProject).toHaveBeenCalledWith(PROJECT_ID, undefined, null, null);
		await post({ job_type: "DESTROY", configuration_id: PROJECT_ID });
		expect(destroyProject).toHaveBeenCalledWith(PROJECT_ID, null, null, { cascade: false });
	});

	it.each([
		["a string that is not a UUID", "approve-me"],
		["an empty string", ""],
		["a number", 7],
		["true", true],
	])("400s an approval_id that is %s, and queues nothing", async (_what, approval_id) => {
		const res = await post({ job_type: "DEPLOY", configuration_id: PROJECT_ID, approval_id });
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "approval_id must be a UUID" });
		expect(runWithActor).not.toHaveBeenCalled();
		expect(provisionProject).not.toHaveBeenCalled();
	});
});

describe("POST /api/jobs — a refused apply or destroy", () => {
	it.each([
		["DEPLOY", provisionProject],
		["DESTROY", destroyProject],
	] as const)("answers 403 with the refusal's code and sentence (%s)", async (job_type, action) => {
		vi.mocked(action).mockRejectedValue(
			new ApplyAuthorizationError("approval_required", "This needs an approval."),
		);
		const res = await post({ job_type, configuration_id: PROJECT_ID });
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: "This needs an approval.", code: "approval_required" });
	});
});

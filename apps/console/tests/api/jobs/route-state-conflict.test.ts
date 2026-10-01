// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// #5090: an enqueue the env-status CAS refuses (another job is still in flight on the env) is a
// STATE CONFLICT, and POST /api/jobs must say so with a 409 carrying the action's message. It was a
// 500, so the first cli-demo run past #5061 printed "(status 500)" for a correct refusal — which
// reads as "the console broke" rather than "a job is already running here".
//
// The action module is mocked so the test pins the ROUTE's mapping alone; the throw site
// (enqueueEnvTransition) is what raises the typed error in production.

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
import {
	destroyProject,
	planProject,
	provisionProject,
} from "@/app/server/actions/projects";
import { getActiveScope } from "@/lib/auth/scope";
import { ensureCliOrgAccess } from "@/lib/authz/guard";
import { verifyCliToken } from "@/lib/cli/auth";
import { EnvStateConflictError } from "@/lib/db/env-status";

const PROJECT_ID = "44444444-4444-4444-8444-444444444444";
const ENV_ID = "55555555-5555-4555-8555-555555555555";

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
});

describe("POST /api/jobs — an env with a job in flight (#5090)", () => {
	it.each([
		["DEPLOY", provisionProject, "enqueueDeploy"],
		["PLAN", planProject, "enqueuePlan"],
		["DESTROY", destroyProject, "enqueueDestroy"],
	] as const)(
		"%s refused by the env-status CAS answers 409 with the action's message",
		async (jobType, action, context) => {
			const conflict = new EnvStateConflictError(context);
			vi.mocked(action).mockRejectedValue(conflict);

			const res = await post({
				job_type: jobType,
				configuration_id: PROJECT_ID,
				environment_id: ENV_ID,
			});

			expect(res.status).toBe(409);
			const body: unknown = await res.json();
			expect(body).toEqual({ error: conflict.message });
			expect(conflict.message).toMatch(/a job may already be in progress/);
		},
	);

	it("an UNtyped failure from the action is still a 500 — only the conflict is re-mapped", async () => {
		vi.mocked(provisionProject).mockRejectedValue(new Error("db exploded"));

		const res = await post({
			job_type: "DEPLOY",
			configuration_id: PROJECT_ID,
			environment_id: ENV_ID,
		});

		expect(res.status).toBe(500);
		const body: unknown = await res.json();
		expect(body).toEqual({ error: "db exploded" });
	});
});

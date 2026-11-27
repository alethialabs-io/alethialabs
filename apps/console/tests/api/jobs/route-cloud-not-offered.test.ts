// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// #6964: a PLAN or DEPLOY of a project whose cloud this deployment does not offer is refused by the
// actions (`buildConfigSnapshot` asks `assertProjectCloudOffered`), and POST /api/jobs answers it as
// a 409 with a `code`, not a 500. The action module is mocked so this pins the ROUTE's mapping
// alone; which job kinds the actions refuse is pinned in tests/actions/projects.test.ts.

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
import { CloudNotOfferedError } from "@/lib/cloud-providers/availability";

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

describe("POST /api/jobs — a cloud this deployment does not offer (#6964)", () => {
	it.each([
		["DEPLOY", provisionProject],
		["PLAN", planProject],
	] as const)("%s refused for the cloud answers 409 with the sentence and a code", async (jobType, action) => {
		vi.mocked(action).mockRejectedValue(new CloudNotOfferedError("alibaba"));

		const res = await post({
			job_type: jobType,
			configuration_id: PROJECT_ID,
			environment_id: ENV_ID,
		});

		expect(res.status).toBe(409);
		const body: unknown = await res.json();
		expect(body).toEqual({
			error: "Alibaba Cloud is not available in this release.",
			code: "cloud_not_offered",
		});
	});
});

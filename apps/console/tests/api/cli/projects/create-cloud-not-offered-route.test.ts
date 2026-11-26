// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// POST /api/cli/projects — a cloud identity on a cloud this deployment does not offer (#6964). The
// refusal is made by the shared insert (`insertProjectWithDefaultFabric`, #6811) and pinned against
// real Postgres in tests/integration/cloud-availability/; this file pins the route's half: the
// refusal is a 409 with a `code` the CLI can branch on, not the 500 it was, carrying the same
// sentence.

import { beforeEach, describe, expect, it, vi } from "vitest";

const IDENTITY = "11111111-1111-4111-8111-111111111111";

vi.mock("@/lib/authz/guard", async (importOriginal) => ({
	// Real: the identity lookup asks it which arms the credential gets (#5481).
	userIdIsTheCaller: (await importOriginal<typeof import("@/lib/authz/guard")>())
		.userIdIsTheCaller,
	authorizeCli: vi.fn(async () => ({
		actor: { userId: "user-1", orgId: "org-1" },
		credential: "session",
	})),
}));
vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({
		// The identity lookup: select().from().where().limit() → one alibaba identity.
		select: () => ({
			from: () => ({
				where: () => ({ limit: async () => [{ id: IDENTITY, provider: "alibaba" }] }),
			}),
		}),
		transaction: async (fn: (tx: unknown) => unknown) => fn({}),
	}),
}));
vi.mock("@/lib/queries/projects", () => ({ insertProjectWithDefaultFabric: vi.fn() }));

import { POST } from "@/app/api/cli/projects/route";
import { CloudNotOfferedError } from "@/lib/cloud-providers/availability";
import { insertProjectWithDefaultFabric } from "@/lib/queries/projects";

/** Calls the route as the CLI would. */
function post() {
	return POST(
		new Request("https://console.local/api/cli/projects", {
			method: "POST",
			body: JSON.stringify({
				project_name: "shop",
				region: "cn-hangzhou",
				cloud_identity_id: IDENTITY,
			}),
		}),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("POST /api/cli/projects — a cloud this deployment does not offer (#6964)", () => {
	it("answers 409 with the sentence and a code, not a 500", async () => {
		vi.mocked(insertProjectWithDefaultFabric).mockRejectedValue(new CloudNotOfferedError("alibaba"));
		const res = await post();
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({
			error: "Alibaba Cloud is not available in this release.",
			code: "cloud_not_offered",
		});
	});

	it("still answers 500 for a failure that is not a refusal", async () => {
		vi.mocked(insertProjectWithDefaultFabric).mockRejectedValue(new Error("connection reset"));
		const res = await post();
		expect(res.status).toBe(500);
	});
});

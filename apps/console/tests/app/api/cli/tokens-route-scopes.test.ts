// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment node

// `POST /api/cli/tokens` and the token limit (AGT-L3). A token carries every scope over every
// project; a request for anything narrower is refused with `narrow_tokens_unavailable` and nothing
// is written. The minting library is real; mocked boundary: the guard and the database insert.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { authorizeCli, insertValues } = vi.hoisted(() => ({
	authorizeCli: vi.fn(),
	insertValues: vi.fn(),
}));

vi.mock("@/lib/authz/guard", () => ({ authorizeCli }));
vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({
		insert: () => ({
			values: (values: unknown) => {
				insertValues(values);
				return {
					returning: () => Promise.resolve([{ id: "tok-1", token_prefix: "alethia_sat_abcd1234" }]),
				};
			},
		}),
	}),
}));
vi.mock("@/lib/authz/activity", () => ({ enforceDecision: vi.fn() }));

import { POST } from "@/app/api/cli/tokens/route";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ALL = ["read", "design", "plan", "apply", "destroy"];

/** A POST to the token route with a JSON body. */
function post(body: unknown): Request {
	return new Request("https://console.test/api/cli/tokens", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	authorizeCli.mockResolvedValue({
		actor: { userId: "u-owner", orgId: "org-A", credential: "session" },
		credential: "session",
		orgScope: ["org-A"],
	});
});

describe("narrower tokens are refused", () => {
	it("refuses fewer scopes, any project list, or both — and mints nothing", async () => {
		const bodies = [
			{ name: "ci", scopes: ["read"] },
			{ name: "ci", scopes: ["read", "design", "plan"] },
			{ name: "ci", project_ids: [PROJECT] },
			{ name: "ci", scopes: ALL, project_ids: [PROJECT] },
		];
		const answers: unknown[] = [];
		for (const body of bodies) {
			const res = await POST(post(body));
			answers.push([res.status, (await res.json()).code]);
		}
		expect(answers).toEqual(bodies.map(() => [400, "narrow_tokens_unavailable"]));
		expect(insertValues).not.toHaveBeenCalled();
	});

	it("names in the refusal that narrower tokens are not available yet", async () => {
		const res = await POST(post({ name: "ci", scopes: ["read"] }));
		expect((await res.json()).error).toMatch(/not available yet/);
	});

	it("refuses an unknown scope, an empty scope list and a malformed project id", async () => {
		const bodies = [
			{ name: "ci", scopes: ["read", "admin"] },
			{ name: "ci", scopes: [] },
			{ name: "ci", project_ids: ["not-a-uuid"] },
			{ name: "ci", project_ids: [] },
		];
		const statuses: number[] = [];
		for (const body of bodies) statuses.push((await POST(post(body))).status);
		expect(statuses).toEqual([400, 400, 400, 400]);
		expect(insertValues).not.toHaveBeenCalled();
	});
});

describe("default tokens are minted as before", () => {
	it("mints every scope over every project when the request names no limit", async () => {
		const res = await POST(post({ name: "ci" }));
		expect(res.status).toBe(201);
		expect(insertValues).toHaveBeenCalledWith(
			expect.objectContaining({ organization_id: "org-A", scopes: ALL, project_ids: null }),
		);
		const body = await res.json();
		expect(body).toMatchObject({ scopes: ALL, project_ids: null, token_prefix: "alethia_sat_abcd1234" });
		expect(body.token).toMatch(/^alethia_sat_/);
	});

	it("accepts every scope named explicitly", async () => {
		const res = await POST(post({ name: "ci", scopes: [...ALL].reverse() }));
		expect(res.status).toBe(201);
		expect(insertValues).toHaveBeenCalledTimes(1);
	});
});

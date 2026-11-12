// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// POST /api/cli/projects/:id/addons/bump (#6549): the route runs the one bump function as the CLI's
// user, answers in the contract's wire form for both arms, and does not forward an internal error's
// text.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/server/actions/addons", () => ({ requestGitopsBump: vi.fn() }));
vi.mock("@/lib/authz/actor-context", () => ({
	runWithActor: (_actor: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/authz/guard", () => ({
	authorizeCli: async () => ({ actor: { userId: "user-1", orgId: "org-1" }, credential: "session", orgScope: ["org-1"] }),
}));
vi.mock("@/lib/cli/project-access", () => ({
	resolveCliProjectAuthorized: async () => ({ id: "44444444-4444-4444-8444-444444444444" }),
}));
vi.mock("@/lib/cli/resolve-project", () => ({
	resolveCliWriteEnvironment: async () => ({ ok: true, id: "55555555-5555-4555-8555-555555555555", name: "prod" }),
}));

import { POST } from "@/app/api/cli/projects/[id]/addons/bump/route";
import { requestGitopsBump } from "@/app/server/actions/addons";
import { cliGitopsBumpResponse } from "@/lib/validations/cli-contract";

const params = { params: Promise.resolve({ id: "shop" }) };

/** POSTs a body as the CLI would. */
function post(body: unknown) {
	return POST(
		new Request("https://console.local/api/cli/projects/shop/addons/bump", { method: "POST", body: JSON.stringify(body) }),
		params,
	);
}

const MANUAL = { file: "addons/ingress-nginx.yaml", field: "spec.source.targetRevision" } satisfies Record<string, string>;

beforeEach(() => {
	vi.mocked(requestGitopsBump).mockReset();
});

describe("POST /api/cli/projects/:id/addons/bump", () => {
	it("runs the bump for the resolved project and environment, and passes --again through", async () => {
		vi.mocked(requestGitopsBump).mockResolvedValue({
			status: "open",
			created: true,
			version: "4.15.1",
			number: 42,
			url: "https://github.com/acme/apps/pull/42",
			file: MANUAL.file,
			field: "spec.source.targetRevision",
		});
		const res = await post({ addon_id: "ingress-nginx", again: true });
		expect(res.status).toBe(200);
		expect(vi.mocked(requestGitopsBump).mock.calls[0]?.[0]).toEqual({
			projectId: "44444444-4444-4444-8444-444444444444",
			environmentId: "55555555-5555-4555-8555-555555555555",
			addonId: "ingress-nginx",
			again: true,
		});
		const body: unknown = await res.json();
		expect(cliGitopsBumpResponse.parse(body)).toEqual({
			status: "open",
			created: true,
			version: "4.15.1",
			...MANUAL,
			number: 42,
			url: "https://github.com/acme/apps/pull/42",
			reason: null,
			message: null,
		});
	});

	it("answers a refusal in the wire form, with the manual instruction", async () => {
		vi.mocked(requestGitopsBump).mockResolvedValue({
			status: "refused",
			reason: "provider-not-supported",
			message: "Alethia opens these pull requests on GitHub only. On GitLab, change the file yourself.",
			version: "4.15.1",
			file: MANUAL.file,
			field: "spec.source.targetRevision",
		});
		const res = await post({ addon_id: "ingress-nginx" });
		const body = cliGitopsBumpResponse.parse(await res.json());
		expect(body).toMatchObject({ status: "refused", reason: "provider-not-supported", number: null, url: null, ...MANUAL });
		expect(vi.mocked(requestGitopsBump).mock.calls[0]?.[0]).toMatchObject({ again: false });
	});

	it("is a 400 without an add-on id, and never calls the bump", async () => {
		const res = await post({});
		expect(res.status).toBe(400);
		expect(requestGitopsBump).not.toHaveBeenCalled();
	});

	it("does not forward an internal error's text", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.mocked(requestGitopsBump).mockImplementation(async () => {
			throw new Error("connect ECONNREFUSED token=gho_SHOULD_NOT_LEAK");
		});
		const res = await post({ addon_id: "ingress-nginx" });
		expect(res.status).toBe(500);
		expect(JSON.stringify(await res.json())).not.toContain("gho_SHOULD_NOT_LEAK");
		expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("gho_SHOULD_NOT_LEAK");
	});

	it("maps an authorization refusal to 403", async () => {
		vi.mocked(requestGitopsBump).mockImplementation(async () => {
			throw new Error("Forbidden: edit on project");
		});
		expect((await post({ addon_id: "ingress-nginx" })).status).toBe(403);
	});
});

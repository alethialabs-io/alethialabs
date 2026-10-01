// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// GET /api/cli/projects/:id/destroy-tree (#5249) — what `alethia project destroy --cascade` prints and
// confirms before it queues anything. Pins the route's resolution and its refusals; the tree itself is
// built by getDestroyTree, tested in tests/actions/projects.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/server/actions/projects", () => ({ getDestroyTree: vi.fn() }));
vi.mock("@/lib/authz/actor-context", () => ({
	runWithActor: vi.fn((_actor: unknown, fn: () => unknown) => fn()),
}));
vi.mock("@/lib/authz/guard", () => ({ authorizeCli: vi.fn() }));
vi.mock("@/lib/cli/resolve-project", () => ({
	resolveCliProject: vi.fn(),
	resolveCliWriteEnvironment: vi.fn(),
}));

import { GET } from "@/app/api/cli/projects/[id]/destroy-tree/route";
import { getDestroyTree } from "@/app/server/actions/projects";
import { authorizeCli } from "@/lib/authz/guard";
import { ForbiddenError } from "@/lib/authz/types";
import { resolveCliProject, resolveCliWriteEnvironment } from "@/lib/cli/resolve-project";

const PROJECT_ID = "44444444-4444-4444-8444-444444444444";
const OWNER_ENV = "55555555-5555-4555-8555-555555555555";
const NS_ENV = "66666666-6666-4666-8666-666666666666";

/** Calls the route as the CLI would. */
function get(query = "") {
	return GET(new Request(`https://console.local/api/cli/projects/boutique/destroy-tree${query}`), {
		params: Promise.resolve({ id: "boutique" }),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(authorizeCli).mockResolvedValue({
		actor: { userId: "user-1", orgId: "org-1" },
		credential: "session",
		orgScope: ["org-1"],
	} as never);
	vi.mocked(resolveCliProject).mockResolvedValue({ id: PROJECT_ID } as never);
	vi.mocked(resolveCliWriteEnvironment).mockResolvedValue({ ok: true, id: OWNER_ENV, name: "prod" });
});

describe("GET /api/cli/projects/:id/destroy-tree", () => {
	it("resolves the project in the caller's org and the ?env= environment, and returns the tree", async () => {
		const tree = [
			{ environment_id: NS_ENV, name: "dev-1", placement_mode: "namespace", status: "ACTIVE", owns_fabric: false, waiting_on: [] },
			{
				environment_id: OWNER_ENV,
				name: "prod",
				placement_mode: "dedicated",
				status: "ACTIVE",
				owns_fabric: true,
				waiting_on: [{ name: "dev-1", status: "ACTIVE" }],
			},
		] as const;
		vi.mocked(getDestroyTree).mockResolvedValue({ tree: tree.map((n) => ({ ...n, waiting_on: [...n.waiting_on] })) });

		const res = await get(`?env=${OWNER_ENV}`);

		expect(res.status).toBe(200);
		expect(authorizeCli).toHaveBeenCalledWith(expect.anything(), "view", { type: "project" });
		expect(resolveCliProject).toHaveBeenCalledWith("org-1", "boutique");
		expect(resolveCliWriteEnvironment).toHaveBeenCalledWith(PROJECT_ID, OWNER_ENV);
		expect(getDestroyTree).toHaveBeenCalledWith(PROJECT_ID, OWNER_ENV);
		expect(await res.json()).toEqual({ tree });
	});

	it("404s a project outside the caller's org without reading any tree", async () => {
		vi.mocked(resolveCliProject).mockResolvedValue(null as never);
		const res = await get();
		expect(res.status).toBe(404);
		expect(getDestroyTree).not.toHaveBeenCalled();
	});

	it("404s when the PDP denies `view` on the project", async () => {
		vi.mocked(getDestroyTree).mockRejectedValue(
			new ForbiddenError("view", { type: "project", id: PROJECT_ID }),
		);
		const res = await get();
		expect(res.status).toBe(404);
	});

	it("names an unknown ?env= rather than silently using the default", async () => {
		vi.mocked(resolveCliWriteEnvironment).mockResolvedValue({ ok: false, reason: "not-found", requested: "nope" });
		const res = await get("?env=nope");
		expect(res.status).toBe(404);
		expect(getDestroyTree).not.toHaveBeenCalled();
	});
});

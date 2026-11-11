// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// POST /api/cli/projects (#6551): an environment-matrix refusal — a reserved placement namespace, or
// two placements resolving to one namespace — comes back as the named refusal, not "Invalid request
// body", and nothing is created.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", async (importOriginal) => ({
	userIdIsTheCaller: (await importOriginal<typeof import("@/lib/authz/guard")>()).userIdIsTheCaller,
	authorizeCli: vi.fn(async () => ({ actor: { userId: "user-1", orgId: "org-1" }, credential: "session" })),
}));
const reached = vi.hoisted(() => ({ db: 0 }));
vi.mock("@/lib/db", () => ({
	// Counted rather than thrown: module init elsewhere calls it. A refused body must not USE it.
	getServiceDb: () => {
		reached.db++;
		return {
			select: () => {
				throw new Error("the database must not be queried for a refused body");
			},
			transaction: () => {
				throw new Error("the database must not be written for a refused body");
			},
		};
	},
}));
vi.mock("@/lib/queries/projects", () => ({ insertProjectWithDefaultFabric: vi.fn() }));

import { POST } from "@/app/api/cli/projects/route";
import { insertProjectWithDefaultFabric } from "@/lib/queries/projects";

/** Calls the route with an environment matrix. */
async function post(environments: unknown[]) {
	const res = await POST(
		new Request("https://console.local/api/cli/projects", {
			method: "POST",
			body: JSON.stringify({ project_name: "shop", region: "eu-west-1", environments }),
		}),
	);
	const json: unknown = await res.json();
	return { status: res.status, error: typeof json === "object" && json && "error" in json ? String(json.error) : "" };
}

const prod = { name: "prod", stage: "production", placement_mode: "dedicated", is_default: true };

describe("POST /api/cli/projects — a refused placement namespace is named", () => {
	it("names a reserved namespace and where it is", async () => {
		const { status, error } = await post([prod, { name: "dev", stage: "development", placement_mode: "namespace", namespace: "argocd" }]);
		expect(status).toBe(400);
		expect(error).toMatch(/^environments\.1\.namespace: Namespace “argocd” is reserved on the host cluster/);
		expect(insertProjectWithDefaultFabric).not.toHaveBeenCalled();
	});

	it("names two placements resolving to one namespace", async () => {
		const { status, error } = await post([
			prod,
			{ name: "dev", stage: "development", placement_mode: "namespace", namespace: "team" },
			{ name: "team", stage: "development", placement_mode: "namespace" },
		]);
		expect(status).toBe(400);
		expect(error).toMatch(/already used by the environment “dev”/);
	});
});

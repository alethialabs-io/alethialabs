// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mocked-boundary test: `deleteEnvironment` refuses with a `conflict` while the environment is live
// or in flight, and deletes it otherwise (#6752). The seams are the same ones
// tests/actions/projects.test.ts stubs — the PDP guard, the org binding and a thenable drizzle
// chain wired through `withActorScope`; the status decision (lib/db/live-env-statuses.ts) is real.
//
// `deleteEnvironment` throws its refusals, so the kind is read off the thrown `ActionRefusal`.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/authz/guard", () => ({
	authorize: vi.fn(),
	authorizeDeferred: vi.fn(),
	authorizeRead: vi.fn(),
	currentActor: vi.fn(),
}));
vi.mock("@/lib/authz/activity", () => ({
	recordAllowed: vi.fn(),
	recordActivity: vi.fn(),
	enforceDecision: vi.fn(),
}));
vi.mock("@/lib/promotions/org-binding", () => ({ assertProjectInActorOrg: vi.fn() }));
vi.mock("@/lib/db", () => ({ withActorScope: vi.fn(), withScope: vi.fn(), getServiceDb: vi.fn() }));
vi.mock("@/lib/scaler", () => ({ notifyScaler: vi.fn() }));
// The modules below are not this file's subject; they would otherwise load Better Auth here.
vi.mock("@/lib/auth", () => ({ auth: { api: {} } }));
vi.mock("@/lib/jobs/visibility", () => ({ jobVisibleTo: vi.fn() }));
vi.mock("@/lib/scanner/infer", () => ({ inferStack: vi.fn() }));
vi.mock("@/lib/auth/owner", () => ({ requireOwner: vi.fn() }));
vi.mock("@/lib/authz/tuple-sync", () => ({ mirrorHierarchyEdge: vi.fn() }));

import { deleteEnvironment } from "@/app/server/actions/projects";
import { ActionRefusal } from "@/lib/actions/result";
import { authorize, currentActor } from "@/lib/authz/guard";
import { withActorScope } from "@/lib/db";
import { projectEnvironments } from "@/lib/db/schema";
import { type ProjectStatus, projectStatus } from "@/lib/db/schema/enums";
import { assertProjectInActorOrg } from "@/lib/promotions/org-binding";

/** Wires a transaction whose environment read answers `rows`; returns the delete spy. */
function seedEnvironment(rows: { id: string; is_default: boolean; status: ProjectStatus }[]) {
	const deleteSpy = vi.fn<(table: unknown) => void>();
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		from: () => chain,
		where: () => chain,
		limit: () => chain,
		then: (resolve: (value: unknown[]) => void) => resolve(rows),
	});
	const tx = {
		select: () => chain,
		delete: (table: unknown) => {
			deleteSpy(table);
			return { where: () => Promise.resolve([]) };
		},
	};
	vi.mocked(withActorScope).mockImplementation(((_actor: unknown, cb: (t: unknown) => unknown) => cb(tx)) as never);
	return { deleteSpy };
}

/** Which statuses block, written out — not read from the set the action uses. */
const BLOCKS: Record<ProjectStatus, boolean> = {
	DRAFT: false,
	QUEUED: true,
	PROVISIONING: true,
	ACTIVE: true,
	FAILED: false,
	DESTROYING: true,
	DESTROYED: false,
};
const blocking = projectStatus.enumValues.filter((s) => BLOCKS[s]);
const nonBlocking = projectStatus.enumValues.filter((s) => !BLOCKS[s]);

beforeEach(() => {
	vi.clearAllMocks();
	const actor = { userId: "user-1", orgId: "org-1", credential: "session" };
	vi.mocked(authorize).mockResolvedValue(actor as never);
	vi.mocked(currentActor).mockResolvedValue(actor as never);
	vi.mocked(assertProjectInActorOrg).mockResolvedValue(undefined);
});

describe("deleteEnvironment while the environment is live or in flight", () => {
	it("covers every status on one side or the other", () => {
		expect([...blocking, ...nonBlocking].sort()).toEqual([...projectStatus.enumValues].sort());
		expect(blocking).toHaveLength(4);
	});

	it.each(blocking)("%s → a conflict refusal, and the row is kept", async (status) => {
		const { deleteSpy } = seedEnvironment([{ id: "env-2", is_default: false, status }]);
		const thrown: unknown = await deleteEnvironment("p1", "env-2").catch((error: unknown) => error);
		expect(thrown).toBeInstanceOf(ActionRefusal);
		expect(thrown).toMatchObject({
			kind: "conflict",
			message: "Destroy this environment before deleting it.",
		});
		expect(deleteSpy).not.toHaveBeenCalled();
	});

	it.each(nonBlocking)("%s → the environment is deleted", async (status) => {
		const { deleteSpy } = seedEnvironment([{ id: "env-2", is_default: false, status }]);
		expect(await deleteEnvironment("p1", "env-2")).toEqual({ success: true });
		expect(deleteSpy).toHaveBeenCalledWith(projectEnvironments);
	});

	it("a live DEFAULT environment is still refused as the default, not as live", async () => {
		const { deleteSpy } = seedEnvironment([{ id: "env-1", is_default: true, status: "ACTIVE" }]);
		await expect(deleteEnvironment("p1", "env-1")).rejects.toThrow(/Cannot delete the project's default/);
		expect(deleteSpy).not.toHaveBeenCalled();
	});
});

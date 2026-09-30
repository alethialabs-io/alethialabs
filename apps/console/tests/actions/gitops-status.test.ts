// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// getGitopsDeployStatus is a thin authz/tenancy shell over lib/gitops/deploy-status.ts. What it
// owns, and so what is asserted here: the PDP gate runs first; an environment that does not
// resolve, or that the org-scoped join does not return (a foreign project's), yields the EMPTY
// model rather than a read; only an environment the join returns reaches the shared read model.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { authorize, getServiceDb, resolveActiveEnvironmentId, readGitopsDeployStatus } =
	vi.hoisted(() => ({
		authorize: vi.fn(),
		getServiceDb: vi.fn(),
		resolveActiveEnvironmentId: vi.fn(),
		readGitopsDeployStatus: vi.fn(),
	}));

vi.mock("@/lib/authz/guard", () => ({ authorize }));
vi.mock("@/lib/db", () => ({ getServiceDb }));
vi.mock("@/app/server/actions/resolve", () => ({ resolveActiveEnvironmentId }));
vi.mock("@/lib/gitops/deploy-status", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/gitops/deploy-status")>();
	return { ...actual, readGitopsDeployStatus };
});

import { getGitopsDeployStatus } from "@/app/server/actions/gitops-status";
import { EMPTY_GITOPS_DEPLOY_STATUS } from "@/lib/gitops/deploy-status";
import { ForbiddenError } from "@/lib/authz/types";

/** A drizzle-ish chain resolving to `rows`, recording the `limit` it was given. */
function mockDb(rows: { id: string }[]) {
	const chain = {
		select: () => chain,
		from: () => chain,
		innerJoin: () => chain,
		where: () => chain,
		limit: vi.fn(() => Promise.resolve(rows)),
	};
	getServiceDb.mockReturnValue(chain);
	return chain;
}

beforeEach(() => {
	vi.clearAllMocks();
	authorize.mockResolvedValue({ orgId: "org-1", userId: "u-1" });
});

describe("getGitopsDeployStatus", () => {
	it("is gated on `view` of the project, and reads nothing when refused", async () => {
		authorize.mockRejectedValue(new ForbiddenError("view", { type: "project", id: "p-1" }, "no"));
		await expect(getGitopsDeployStatus("p-1")).rejects.toBeInstanceOf(ForbiddenError);
		expect(authorize).toHaveBeenCalledWith("view", { type: "project", id: "p-1" });
		expect(readGitopsDeployStatus).not.toHaveBeenCalled();
	});

	it("returns the empty model when no environment resolves", async () => {
		mockDb([]);
		resolveActiveEnvironmentId.mockRejectedValue(new Error("no env"));
		await expect(getGitopsDeployStatus("p-1")).resolves.toBe(EMPTY_GITOPS_DEPLOY_STATUS);
		expect(readGitopsDeployStatus).not.toHaveBeenCalled();
	});

	it("returns the empty model when the org-scoped join returns no environment", async () => {
		const db = mockDb([]);
		resolveActiveEnvironmentId.mockResolvedValue("env-foreign");
		await expect(getGitopsDeployStatus("p-1", "env-foreign")).resolves.toBe(
			EMPTY_GITOPS_DEPLOY_STATUS,
		);
		expect(db.limit).toHaveBeenCalledWith(1);
		expect(readGitopsDeployStatus).not.toHaveBeenCalled();
	});

	it("reads the shared model for an environment the join returns", async () => {
		mockDb([{ id: "env-1" }]);
		resolveActiveEnvironmentId.mockResolvedValue("env-1");
		const status = { ...EMPTY_GITOPS_DEPLOY_STATUS };
		readGitopsDeployStatus.mockResolvedValue(status);
		await expect(getGitopsDeployStatus("p-1", null)).resolves.toBe(status);
		expect(resolveActiveEnvironmentId).toHaveBeenCalledWith("p-1", undefined);
		expect(readGitopsDeployStatus).toHaveBeenCalledWith("p-1", "env-1");
	});
});

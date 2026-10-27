// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6128: the project General writes in the mutation contract. The rules stay in projects.ts
// (`updateProjectName` / `deleteProject`, tested in tests/actions/projects.test.ts); what is pinned
// here is the ADAPTATION — that a refusal those return arrives as the kind the form renders it by:
// a rename's under the name FIELD, a delete's as a `conflict` the danger zone keeps on screen.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/app/server/actions/projects", () => ({
	updateProjectName: vi.fn(),
	deleteProject: vi.fn(),
}));

import { removeProject, renameProject } from "@/app/server/actions/project-settings";
import { deleteProject, updateProjectName } from "@/app/server/actions/projects";
import { ForbiddenError } from "@/lib/authz/types";

const PROJECT = "5f0c4b8e-2d1a-4c3b-9e7f-0a1b2c3d4e5f";
const TAKEN = 'A project named "Taken" already exists in this organization.';
const LIVE = "This project has live or in-flight environments. Destroy them before deleting the project.";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("renameProject", () => {
	it("returns the persisted name", async () => {
		vi.mocked(updateProjectName).mockResolvedValue({ ok: true, project_name: "Renamed" });
		expect(await renameProject({ projectId: PROJECT, name: " Renamed " })).toEqual({
			ok: true,
			data: { project_name: "Renamed" },
		});
		// The schema trims, so what the rules see is what is stored.
		expect(updateProjectName).toHaveBeenCalledWith(PROJECT, "Renamed");
	});

	it("puts the server's refusal under the name field", async () => {
		vi.mocked(updateProjectName).mockResolvedValue({ ok: false, error: TAKEN });
		expect(await renameProject({ projectId: PROJECT, name: "Taken" })).toEqual({
			ok: false,
			error: { kind: "validation", message: TAKEN, fields: { name: [TAKEN] } },
		});
	});

	it("refuses a name the shared rule refuses, before the rules run", async () => {
		const result = await renameProject({ projectId: PROJECT, name: "   " });
		expect(result).toMatchObject({
			ok: false,
			error: {
				kind: "validation",
				fields: { name: expect.arrayContaining(["A project name is required"]) },
			},
		});
		expect(updateProjectName).not.toHaveBeenCalled();
	});

	it("refuses an id that is not a project id", async () => {
		const result = await renameProject({ projectId: "../other", name: "Fine" });
		expect(result).toMatchObject({ ok: false, error: { kind: "validation" } });
		expect(updateProjectName).not.toHaveBeenCalled();
	});

	it("passes a PDP refusal on as forbidden", async () => {
		vi.mocked(updateProjectName).mockRejectedValue(new ForbiddenError("edit", { type: "project", id: PROJECT }));
		expect(await renameProject({ projectId: PROJECT, name: "Fine" })).toMatchObject({
			ok: false,
			error: { kind: "forbidden" },
		});
	});
});

describe("removeProject", () => {
	it("deletes", async () => {
		vi.mocked(deleteProject).mockResolvedValue({ ok: true });
		expect(await removeProject({ projectId: PROJECT })).toEqual({ ok: true, data: { deleted: true } });
		expect(deleteProject).toHaveBeenCalledWith(PROJECT);
	});

	it("answers the live-environment refusal as a conflict with the server's sentence", async () => {
		vi.mocked(deleteProject).mockResolvedValue({ ok: false, error: LIVE });
		expect(await removeProject({ projectId: PROJECT })).toEqual({
			ok: false,
			error: { kind: "conflict", message: LIVE },
		});
	});
});

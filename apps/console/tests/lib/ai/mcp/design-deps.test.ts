// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The default dependencies of the MCP design tools (lib/ai/mcp/design-deps.ts): the writes go through
// the server actions the canvas and the CLI design route use, with the hashed key for the audit row;
// the two refusals a caller can act on come back as data and anything else is rethrown.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/app/server/actions/projects", () => ({
	getProjectAsFormData: vi.fn(),
	tryCreateProject: vi.fn(),
	updateProjectDesign: vi.fn(),
}));
vi.mock("@/lib/cli/resolve-project", () => ({ resolveCliWriteEnvironment: vi.fn() }));
vi.mock("@/lib/ai/mcp/design-store", () => ({
	designKeyHash: vi.fn(),
	findKeyedDesignWrite: vi.fn(),
	findProjectByName: vi.fn(),
	readDesignRevision: vi.fn(),
}));

import { getProjectAsFormData, tryCreateProject, updateProjectDesign } from "@/app/server/actions/projects";
import { defaultDesignDeps } from "@/lib/ai/mcp/design-deps";
import { designKeyHash, findKeyedDesignWrite, findProjectByName, readDesignRevision } from "@/lib/ai/mcp/design-store";
import { resolveCliWriteEnvironment } from "@/lib/cli/resolve-project";
import { CredentialKnobRefusedError } from "@/lib/cloud-providers/credential-knobs";
import { CloudIdentityRefusedError } from "@/lib/cloud-providers/design-identities";

const DESIGN = { project: { project_name: "api" } } as never;

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(resolveCliWriteEnvironment).mockResolvedValue({ ok: true, id: "e1", name: "" });
});

describe("defaultDesignDeps", () => {
	it("wires the store reads", () => {
		expect(defaultDesignDeps.designRevision).toBe(readDesignRevision);
		expect(defaultDesignDeps.findKeyedWrite).toBe(findKeyedDesignWrite);
		expect(defaultDesignDeps.findProjectByName).toBe(findProjectByName);
		expect(defaultDesignDeps.keyHash).toBe(designKeyHash);
	});

	it("reads the design through getProjectAsFormData", async () => {
		vi.mocked(getProjectAsFormData).mockResolvedValue({ formData: DESIGN, provider: "aws" });
		expect(await defaultDesignDeps.readDesign("p1", undefined)).toBe(DESIGN);
		expect(getProjectAsFormData).toHaveBeenCalledWith("p1", undefined);
	});

	it("saves through updateProjectDesign to the resolved environment, with the key", async () => {
		expect(await defaultDesignDeps.writeDesign({ projectId: "p1", environmentId: undefined, design: DESIGN, keyHash: "h" })).toEqual({
			ok: true,
			value: null,
		});
		expect(resolveCliWriteEnvironment).toHaveBeenCalledWith("p1", undefined);
		expect(updateProjectDesign).toHaveBeenCalledWith("p1", "e1", DESIGN, { idempotencyKey: "h" });
	});

	it("answers an environment that does not resolve as a refusal, saving nothing", async () => {
		vi.mocked(resolveCliWriteEnvironment).mockResolvedValue({ ok: false, reason: "not-found", requested: "e9" });
		expect(await defaultDesignDeps.writeDesign({ projectId: "p1", environmentId: "e9", design: DESIGN, keyHash: "h" })).toEqual({
			ok: false,
			error: "That environment was not found in this project.",
		});
		expect(updateProjectDesign).not.toHaveBeenCalled();
	});

	it("returns the credential and cloud-account refusals as data and rethrows anything else", async () => {
		const input = { projectId: "p1", environmentId: "e1", design: DESIGN, keyHash: "h" };
		vi.mocked(updateProjectDesign).mockRejectedValueOnce(new CredentialKnobRefusedError("a credential is not stored here", "databases[0]"));
		expect(await defaultDesignDeps.writeDesign(input)).toMatchObject({ ok: false });
		vi.mocked(updateProjectDesign).mockRejectedValueOnce(Object.create(CloudIdentityRefusedError.prototype, { message: { value: "no" } }));
		expect(await defaultDesignDeps.writeDesign(input)).toEqual({ ok: false, error: "no" });
		vi.mocked(updateProjectDesign).mockRejectedValueOnce(new Error("db down"));
		await expect(defaultDesignDeps.writeDesign(input)).rejects.toThrow("db down");
	});

	it("creates through tryCreateProject with the key, passing a refusal through", async () => {
		vi.mocked(tryCreateProject).mockResolvedValueOnce({ ok: true, project: { id: "p9" } } as never);
		expect(await defaultDesignDeps.createProject({ design: DESIGN, keyHash: "h" })).toEqual({ ok: true, value: { projectId: "p9" } });
		expect(tryCreateProject).toHaveBeenCalledWith(DESIGN, { idempotencyKey: "h" });
		vi.mocked(tryCreateProject).mockResolvedValueOnce({ ok: false, error: "That name is taken." } as never);
		expect(await defaultDesignDeps.createProject({ design: DESIGN, keyHash: "h" })).toEqual({ ok: false, error: "That name is taken." });
	});
});

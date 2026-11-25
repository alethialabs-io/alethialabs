// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The MCP design tools (lib/ai/mcp/design.ts) over stood-in dependencies:
//
//   - validate_design returns the board validator's problems as data, each with a JSON Pointer;
//   - apply_design_patch reads (and so authorizes) the design first, answers a repeated key with the
//     revision its first write made and writes nothing, refuses a stale base revision as a conflict,
//     returns patch and validation problems as data, and saves only a design the validator accepts;
//   - create_project answers a repeated key with the project it created, refuses a taken name as
//     data, takes the name argument as the project's name, and returns a server refusal as data.

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createDesignHandlers, type DesignDeps, validateDesign } from "@/lib/ai/mcp/design";
import type { HandlerContext } from "@/lib/ai/mcp/served";

const CTX: HandlerContext = {
	actor: { userId: "user-1", orgId: "org-1", credential: "agent_oauth", credentialRef: "client-1" },
	appOrigin: "https://console.example",
};

/** A design the board's validator accepts. */
const DESIGN = {
	project: {
		project_name: "api",
		environment_stage: "development",
		region: "eu-west-1",
		cloud_identity_id: "660e8400-e29b-41d4-a716-446655440000",
		iac_version: "1.11.4",
	},
	network: { provision_network: true, cidr_block: "10.0.0.0/16", single_nat_gateway: true },
	cluster: {
		cluster_version: "1.32",
		provider_config: { enable_karpenter: true },
		instance_types: ["t3.medium"],
		node_min_size: 2,
		node_max_size: 5,
		node_desired_size: 2,
	},
	dns: { enabled: false },
	repositories: {},
	databases: [],
	caches: [],
	queues: [],
	topics: [],
	nosql_tables: [],
	secrets: [],
};

/** Dependencies that fail loudly unless a test stands one in. */
function deps(over: Partial<DesignDeps> = {}): DesignDeps {
	const unexpected = (name: string) =>
		vi.fn(async () => {
			throw new Error(`unexpected call: ${name}`);
		});
	return {
		readDesign: vi.fn(async () => DESIGN),
		designRevision: vi.fn(async () => 7),
		findKeyedWrite: vi.fn(async () => null),
		findProjectByName: vi.fn(async () => null),
		keyHash: (actor, key) => `hash:${actor.userId}:${key}`,
		writeDesign: unexpected("writeDesign"),
		createProject: unexpected("createProject"),
		...over,
	};
}

const PATCH = {
	project_id: "p1",
	base_revision: 7,
	patch: [{ op: "replace", path: "/project/region", value: "eu-central-1" }],
	idempotency_key: "patch-key-1",
};

describe("validate_design", () => {
	it("accepts a valid design", async () => {
		expect(await createDesignHandlers(deps()).validate_design.call({ design: DESIGN }, CTX)).toEqual({ valid: true, errors: [] });
	});

	it("returns each problem as data with its JSON Pointer", async () => {
		const result = await createDesignHandlers(deps()).validate_design.call(
			{ design: { ...DESIGN, network: { ...DESIGN.network, cidr_block: 7 } } },
			CTX,
		);
		expect(result).toMatchObject({ valid: false, errors: [expect.objectContaining({ path: "/network/cidr_block", fix: null })] });
	});

	it("refuses an empty document", () => {
		expect(validateDesign({}).ok).toBe(false);
	});
});

describe("apply_design_patch", () => {
	it("saves the patched design under the caller's key and answers the revision that write made", async () => {
		const writeDesign = vi.fn(async () => ({ ok: true as const, value: null }));
		const findKeyedWrite = vi.fn<DesignDeps["findKeyedWrite"]>().mockResolvedValueOnce(null).mockResolvedValueOnce(9);
		const d = deps({ writeDesign, findKeyedWrite });
		expect(await createDesignHandlers(d).apply_design_patch.call({ ...PATCH, environment_id: "e1" }, CTX)).toEqual({
			status: "applied",
			revision: 9,
			current_revision: null,
			errors: [],
			pull_request_url: null,
		});
		expect(d.readDesign).toHaveBeenCalledWith("p1", "e1");
		expect(writeDesign).toHaveBeenCalledWith({
			projectId: "p1",
			environmentId: "e1",
			design: expect.objectContaining({ project: expect.objectContaining({ region: "eu-central-1" }) }),
			keyHash: "hash:user-1:patch-key-1",
		});
	});

	it("falls back to the project's revision when the keyed row cannot be read back", async () => {
		const designRevision = vi.fn<DesignDeps["designRevision"]>().mockResolvedValueOnce(7).mockResolvedValueOnce(12);
		const d = deps({ designRevision, writeDesign: vi.fn(async () => ({ ok: true as const, value: null })) });
		expect(await createDesignHandlers(d).apply_design_patch.call(PATCH, CTX)).toMatchObject({ status: "applied", revision: 12 });
	});

	it("answers a repeated key with the first write's revision and writes nothing", async () => {
		const d = deps({ findKeyedWrite: vi.fn(async () => 9) });
		expect(await createDesignHandlers(d).apply_design_patch.call(PATCH, CTX)).toMatchObject({ status: "applied", revision: 9 });
		expect(d.writeDesign).not.toHaveBeenCalled();
		expect(d.designRevision).not.toHaveBeenCalled();
	});

	it("reads the design before anything else, so an unauthorized caller learns nothing", async () => {
		const d = deps({ readDesign: vi.fn(async () => Promise.reject(new Error("Forbidden"))) });
		await expect(createDesignHandlers(d).apply_design_patch.call(PATCH, CTX)).rejects.toThrow("Forbidden");
		expect(d.findKeyedWrite).not.toHaveBeenCalled();
		expect(d.designRevision).not.toHaveBeenCalled();
	});

	it("refuses a stale base revision as a conflict naming the current one", async () => {
		const d = deps({ designRevision: vi.fn(async () => 8) });
		expect(await createDesignHandlers(d).apply_design_patch.call(PATCH, CTX)).toEqual({
			status: "conflict",
			revision: null,
			current_revision: 8,
			errors: [],
			pull_request_url: null,
		});
		expect(d.writeDesign).not.toHaveBeenCalled();
	});

	it("returns a patch that does not apply as data", async () => {
		const d = deps();
		const result = await createDesignHandlers(d).apply_design_patch.call(
			{ ...PATCH, patch: [{ op: "remove", path: "/nope" }] },
			CTX,
		);
		expect(result).toMatchObject({ status: "invalid", errors: [{ path: "/nope", code: "path_not_found" }] });
		expect(d.writeDesign).not.toHaveBeenCalled();
	});

	it("returns a patched design the validator refuses as data", async () => {
		const d = deps();
		const result = await createDesignHandlers(d).apply_design_patch.call(
			{ ...PATCH, patch: [{ op: "replace", path: "/network/cidr_block", value: 7 }] },
			CTX,
		);
		expect(result).toMatchObject({ status: "invalid", errors: [{ path: "/network/cidr_block" }] });
		expect(d.writeDesign).not.toHaveBeenCalled();
	});

	it("returns a refusal from the save as data", async () => {
		const d = deps({ writeDesign: vi.fn(async () => ({ ok: false as const, error: "That environment was not found in this project." })) });
		expect(await createDesignHandlers(d).apply_design_patch.call(PATCH, CTX)).toMatchObject({
			status: "invalid",
			errors: [{ path: "", code: "refused", message: "That environment was not found in this project." }],
		});
	});
});

describe("create_project", () => {
	const CREATE = { name: "billing", design: DESIGN, idempotency_key: "create-key-1" };

	it("creates the project under the name argument and the caller's key", async () => {
		const createProject = vi.fn(async () => ({ ok: true as const, value: { projectId: "p9" } }));
		const d = deps({ createProject, findKeyedWrite: vi.fn(async () => 31) });
		expect(await createDesignHandlers(d).create_project.call(CREATE, CTX)).toEqual({
			status: "created",
			project_id: "p9",
			revision: 31,
			errors: [],
		});
		expect(createProject).toHaveBeenCalledWith({
			design: expect.objectContaining({ project: expect.objectContaining({ project_name: "billing" }) }),
			keyHash: "hash:user-1:create-key-1",
		});
	});

	it("answers revision 0 when the creation row cannot be read back", async () => {
		const d = deps({ createProject: vi.fn(async () => ({ ok: true as const, value: { projectId: "p9" } })) });
		expect(await createDesignHandlers(d).create_project.call(CREATE, CTX)).toMatchObject({ revision: 0 });
	});

	it("answers a repeated key with the project it created and creates nothing", async () => {
		const d = deps({ findProjectByName: vi.fn(async () => "p9"), findKeyedWrite: vi.fn(async () => 31) });
		expect(await createDesignHandlers(d).create_project.call(CREATE, CTX)).toEqual({
			status: "created",
			project_id: "p9",
			revision: 31,
			errors: [],
		});
		expect(d.findKeyedWrite).toHaveBeenCalledWith(CTX.actor, "p9", "hash:user-1:create-key-1");
		expect(d.createProject).not.toHaveBeenCalled();
	});

	it("refuses a name another project holds, as data and without its id", async () => {
		const d = deps({ findProjectByName: vi.fn(async () => "p-other") });
		expect(await createDesignHandlers(d).create_project.call({ ...CREATE, name: " billing " }, CTX)).toEqual({
			status: "invalid",
			project_id: null,
			revision: null,
			errors: [
				{
					path: "/name",
					code: "name_taken",
					message: "A project named billing already exists in this organization.",
					fix: "Choose another name.",
				},
			],
		});
	});

	it("returns an invalid design as data, a design with no project section included", async () => {
		const d = deps();
		const result = await createDesignHandlers(d).create_project.call({ ...CREATE, design: { databases: [] } }, CTX);
		expect(result).toMatchObject({ status: "invalid", project_id: null });
		expect(d.createProject).not.toHaveBeenCalled();
	});

	it("returns a refusal from the create as data", async () => {
		const d = deps({ createProject: vi.fn(async () => ({ ok: false as const, error: "That cloud account cannot be used." })) });
		expect(await createDesignHandlers(d).create_project.call(CREATE, CTX)).toMatchObject({
			status: "invalid",
			errors: [{ code: "refused", message: "That cloud account cannot be used." }],
		});
	});
});

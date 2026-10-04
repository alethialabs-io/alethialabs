// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// PATCH /api/cli/projects/:id/components/:kind/:name?env= (#5526) — what `alethia apply` calls when
// a named component's declared fields differ from the server's.
//
// The authorization here is the REAL `authorizeCli`, not a mock of it: a test that stubs the guard
// to return 403 for a viewer proves only that the route forwards a 403. What is mocked is the
// boundary under it — the token verifier, the scope resolver, the member table and the PDP — and
// the PDP decides from the built-in role table (`BUILT_IN_ROLES`), so "a viewer is refused" is
// answered by the same permission list production grants a viewer. The org binding is pinned the
// same way: `resolveCliProject` finds the project only when asked with the org that owns it, so a
// route that resolved it with anything but the caller's own org would fail the tests below.
//
// `validateComponentFields` is real, so "settable" is the registry's definition, the one POST uses.
// `updateProjectComponent` is mocked for the route cases and driven for real (over a recording db)
// at the bottom.

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Action, Resource } from "@/lib/authz/registry";
import type { Actor, ResourceRef } from "@/lib/authz/types";

const ORG_A = "org-a";
const ORG_B = "org-b";
const PROJECT_ID = "44444444-4444-4444-8444-444444444444";
const ENV_ID = "55555555-5555-4555-8555-555555555555";

/** Who each test user is: their home org and their built-in role in it. */
const USERS: Record<string, { org: string; role: "owner" | "operator" | "viewer" }> = {
	"u-editor": { org: ORG_A, role: "operator" },
	"u-viewer": { org: ORG_A, role: "viewer" },
	"u-outsider": { org: ORG_B, role: "owner" },
};

/** The calling user (null: no token), and what the fake db's update chain recorded and returns. */
interface Hoisted {
	state: { user: string | null };
	dbUpdate: {
		set: Mock<(values: Record<string, unknown>) => void>;
		where: Mock<(predicate: SQL) => void>;
		rows: unknown[];
	};
}
const { state, dbUpdate } = vi.hoisted((): Hoisted => ({
	state: { user: "u-editor" },
	dbUpdate: { set: vi.fn(), where: vi.fn(), rows: [] },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/owner", () => ({ getOwnerScope: vi.fn() }));
vi.mock("@/lib/authz/actor-context", () => ({ getInjectedActor: vi.fn(() => undefined) }));
vi.mock("@/lib/cli/auth", () => ({
	verifyCliToken: vi.fn(async () =>
		state.user
			? { payload: { sub: state.user }, error: null }
			: { payload: null, error: new Response(JSON.stringify({ error: "no token" }), { status: 401 }) },
	),
}));
// The scope a user resolves to: their home org. A named org they are not in resolves to their home
// org too — which `resolveNamedOrgScope` refuses as a substitution.
vi.mock("@/lib/auth/scope", () => ({
	getActiveScope: vi.fn(async (userId: string) => ({ userId, orgId: USERS[userId]?.org ?? userId })),
}));
// The PDP, deciding from the real built-in role table.
vi.mock("@/lib/authz", async () => {
	const { BUILT_IN_ROLES } = await import("@/lib/authz/registry");
	const { ForbiddenError } = await import("@/lib/authz/types");
	/** Whether the user's built-in role in the actor's org grants `type:action`. */
	const allowed = (actor: Actor, action: Action, type: Resource) => {
		const u = USERS[actor.userId];
		if (!u || u.org !== actor.orgId) return false;
		const grants = BUILT_IN_ROLES[u.role];
		return grants === "*" || grants.includes(`${type}:${action}`);
	};
	return {
		getPdp: () => ({
			enforce: async (actor: Actor, action: Action, resource: ResourceRef) => {
				if (!allowed(actor, action, resource.type)) throw new ForbiddenError(action, resource);
			},
			can: async (actor: Actor, action: Action, resource: ResourceRef) => ({
				allowed: allowed(actor, action, resource.type),
			}),
			bulkCheck: vi.fn(),
			listAccessible: vi.fn(),
		}),
	};
});
// The member table (read by `isActiveOrgMember` for an X-Alethia-Org header) holds no row for the
// outsider in org A; the update chain records what `updateProjectComponent` writes.
vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({
		select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
		update: () => ({
			set: (values: Record<string, unknown>) => {
				dbUpdate.set(values);
				return {
					where: (predicate: SQL) => {
						dbUpdate.where(predicate);
						return { returning: async () => dbUpdate.rows };
					},
				};
			},
		}),
	}),
}));
vi.mock("@/lib/cli/resolve-project", () => ({
	// Org-bound: the project exists in org A and nowhere else.
	resolveCliProject: vi.fn(async (orgId: string) => (orgId === ORG_A ? { id: PROJECT_ID } : null)),
	resolveCliWriteEnvironment: vi.fn(),
}));
vi.mock("@/lib/cli/project-components", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/cli/project-components")>();
	return { ...actual, updateProjectComponent: vi.fn() };
});

import { PATCH } from "@/app/api/cli/projects/[id]/components/[kind]/[name]/route";
import { updateProjectComponent } from "@/lib/cli/project-components";
import { resolveCliProject, resolveCliWriteEnvironment } from "@/lib/cli/resolve-project";

const WIRE = {
	id: "c1",
	kind: "databases",
	name: "orders",
	status: "ACTIVE",
	cloud_identity_id: null,
	config: { engine: "postgres", max_capacity: 8 },
};

/** Calls the route as the CLI would: PATCH with a JSON body, `?env=prod`. */
function patch(
	body: unknown,
	{
		kind = "databases",
		name = "orders",
		headers = {},
		env = "prod",
	}: { kind?: string; name?: string; headers?: Record<string, string>; env?: string } = {},
) {
	return PATCH(
		new Request(`https://console.local/api/cli/projects/${PROJECT_ID}/components/${kind}/${name}?env=${env}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Authorization: "Bearer t", ...headers },
			body: typeof body === "string" ? body : JSON.stringify(body),
		}),
		{ params: Promise.resolve({ id: PROJECT_ID, kind, name }) },
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	state.user = "u-editor";
	dbUpdate.rows = [];
	vi.mocked(resolveCliWriteEnvironment).mockResolvedValue({ ok: true, id: ENV_ID, name: "prod" });
	vi.mocked(updateProjectComponent).mockResolvedValue(WIRE);
});

describe("PATCH /api/cli/projects/:id/components/:kind/:name", () => {
	it("200: updates only the fields sent, in the caller's org and the ?env= environment", async () => {
		const res = await patch({ fields: { max_capacity: 8 } });

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ component: WIRE });
		expect(resolveCliProject).toHaveBeenCalledWith(ORG_A, PROJECT_ID);
		expect(resolveCliWriteEnvironment).toHaveBeenCalledWith(PROJECT_ID, "prod");
		expect(updateProjectComponent).toHaveBeenCalledWith("databases", PROJECT_ID, ENV_ID, "orders", {
			max_capacity: 8,
		});
	});

	it.each([
		["an unknown field", { colour: "red" }, /Unknown field\(s\) for databases: colour/],
		// A real column of the table that is not in the settable list — server-managed or not
		// authorable from the CLI. The same refusal POST gives.
		["a non-settable column", { engine_family: "postgres" }, /Unknown field\(s\) for databases: engine_family/],
		["a server-managed column", { status: "ACTIVE" }, /Unknown field\(s\) for databases: status/],
		["a value of the wrong type", { max_capacity: "big" }, /Invalid value for max_capacity/],
		["no fields at all", {}, /No fields to update/],
	])("400: %s", async (_label, fields, message) => {
		const res = await patch({ fields });
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(message);
		expect(updateProjectComponent).not.toHaveBeenCalled();
	});

	it("400: a body with anything beside `fields` (a rename) is refused, not ignored", async () => {
		const res = await patch({ name: "orders-v2", fields: { max_capacity: 8 } });
		expect(res.status).toBe(400);
		expect(updateProjectComponent).not.toHaveBeenCalled();
	});

	it("400: a singleton kind is updated through add, not here", async () => {
		const res = await patch({ fields: { node_max_size: 4 } }, { kind: "cluster", name: "cluster" });
		expect(res.status).toBe(400);
		expect(updateProjectComponent).not.toHaveBeenCalled();
	});

	it("400: an unknown kind", async () => {
		const res = await patch({ fields: { x: 1 } }, { kind: "warehouses" });
		expect(res.status).toBe(400);
	});

	it("404: no component of that name in that environment", async () => {
		vi.mocked(updateProjectComponent).mockResolvedValue(null);
		const res = await patch({ fields: { max_capacity: 8 } }, { name: "nope" });
		expect(res.status).toBe(404);
		expect((await res.json()).error).toBe("Component not found");
	});

	it("404: an unknown ?env= is named rather than falling back to the default", async () => {
		vi.mocked(resolveCliWriteEnvironment).mockResolvedValue({ ok: false, reason: "not-found", requested: "qa" });
		const res = await patch({ fields: { max_capacity: 8 } }, { env: "qa" });
		expect(res.status).toBe(404);
		expect(updateProjectComponent).not.toHaveBeenCalled();
	});

	it("403: a viewer of the project's own org cannot edit it", async () => {
		state.user = "u-viewer";
		const res = await patch({ fields: { max_capacity: 8 } });
		expect(res.status).toBe(403);
		expect(resolveCliProject).not.toHaveBeenCalled();
		expect(updateProjectComponent).not.toHaveBeenCalled();
	});

	it("404: an owner of ANOTHER org cannot reach this org's project by id", async () => {
		state.user = "u-outsider";
		const res = await patch({ fields: { max_capacity: 8 } });
		expect(res.status).toBe(404);
		expect(resolveCliProject).toHaveBeenCalledWith(ORG_B, PROJECT_ID);
		expect(updateProjectComponent).not.toHaveBeenCalled();
	});

	it("403: another org's member naming this org in X-Alethia-Org is refused", async () => {
		state.user = "u-outsider";
		const res = await patch({ fields: { max_capacity: 8 } }, { headers: { "X-Alethia-Org": ORG_A } });
		expect(res.status).toBe(403);
		expect(resolveCliProject).not.toHaveBeenCalled();
		expect(updateProjectComponent).not.toHaveBeenCalled();
	});

	it("401: no token", async () => {
		state.user = null;
		const res = await patch({ fields: { max_capacity: 8 } });
		expect(res.status).toBe(401);
		expect(updateProjectComponent).not.toHaveBeenCalled();
	});
});

describe("updateProjectComponent", () => {
	/** The real function, past the route's mock of it. */
	async function real() {
		const mod = await vi.importActual<typeof import("@/lib/cli/project-components")>(
			"@/lib/cli/project-components",
		);
		return mod.updateProjectComponent;
	}

	it("writes only the given fields, scoped to project, environment AND name", async () => {
		dbUpdate.rows = [
			{
				id: "c1",
				org_id: ORG_A,
				project_id: PROJECT_ID,
				environment_id: ENV_ID,
				name: "orders",
				status: "ACTIVE",
				engine: "postgres",
				max_capacity: 8,
			},
		];
		const update = await real();
		const wire = await update("databases", PROJECT_ID, ENV_ID, "orders", { max_capacity: 8 });

		const set = dbUpdate.set.mock.calls[0]?.[0];
		const predicate = dbUpdate.where.mock.calls[0]?.[0];
		if (!set || !predicate) throw new Error("the update chain was not driven");
		expect(Object.keys(set).sort()).toEqual(["max_capacity", "updated_at"]);
		expect(set.max_capacity).toBe(8);
		const { sql, params } = new PgDialect().sqlToQuery(predicate);
		expect(sql).toMatch(/"project_id" = .*"environment_id" = .*"name" = /);
		expect(params).toEqual([PROJECT_ID, ENV_ID, "orders"]);
		expect(wire).toEqual({
			id: "c1",
			kind: "databases",
			name: "orders",
			status: "ACTIVE",
			cloud_identity_id: null,
			config: { environment_id: ENV_ID, engine: "postgres", max_capacity: 8 },
		});
	});

	it("returns null when no row matched (the route's 404)", async () => {
		const update = await real();
		expect(await update("databases", PROJECT_ID, ENV_ID, "nope", { max_capacity: 8 })).toBeNull();
	});

	it("refuses a singleton and an empty write rather than guessing", async () => {
		const update = await real();
		await expect(update("cluster", PROJECT_ID, ENV_ID, "", { node_max_size: 4 })).rejects.toThrow(/singleton/);
		await expect(update("databases", PROJECT_ID, ENV_ID, "orders", {})).rejects.toThrow(/no fields/);
		expect(dbUpdate.set).not.toHaveBeenCalled();
	});
});

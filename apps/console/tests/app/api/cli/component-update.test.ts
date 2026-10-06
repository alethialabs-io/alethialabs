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
const OTHER_PROJECT_ID = "66666666-6666-4666-8666-666666666666";
const OTHER_ENV_ID = "77777777-7777-4777-8777-777777777777";
const IDENTITY_A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const IDENTITY_B = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
const IDENTITY_A_SOMEONE_ELSES = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
const IDENTITY_A_MINE = "d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4";

/** Environments, each under ONE project. `prod` exists in both; only ours may be written. */
const ENVS = [
	{ id: ENV_ID, project_id: PROJECT_ID, name: "prod", stage: "production" },
	{ id: OTHER_ENV_ID, project_id: OTHER_PROJECT_ID, name: "prod", stage: "production" },
];
/** Cloud identities: an org one in each org, and two personal ones in org A. */
const IDENTITIES = [
	{ id: IDENTITY_A, org_id: ORG_A, scope: "org", user_id: "u-admin" },
	{ id: IDENTITY_B, org_id: ORG_B, scope: "org", user_id: "u-outsider" },
	{ id: IDENTITY_A_SOMEONE_ELSES, org_id: ORG_A, scope: "personal", user_id: "u-viewer" },
	{ id: IDENTITY_A_MINE, org_id: ORG_A, scope: "personal", user_id: "u-editor" },
];

/** Who each test user is: their home org and their built-in role in it. */
const USERS: Record<string, { org: string; role: "owner" | "operator" | "viewer" }> = {
	"u-editor": { org: ORG_A, role: "operator" },
	"u-viewer": { org: ORG_A, role: "viewer" },
	"u-outsider": { org: ORG_B, role: "owner" },
};

/** The calling user (null: no token), what the fake db's update chain recorded and returns, the
 * component row a SELECT on a component table answers (the refusal read, #5551), and what an upsert
 * was asked to do. */
interface Hoisted {
	state: { user: string | null };
	dbUpdate: {
		set: Mock<(values: Record<string, unknown>) => void>;
		where: Mock<(predicate: SQL) => void>;
		rows: unknown[];
	};
	stored: { row: Record<string, unknown> | null };
	dbInsert: {
		conflict: Mock<(arg: { set: Record<string, unknown>; setWhere?: SQL }) => void>;
		rows: unknown[];
	};
}
const { state, dbUpdate, stored, dbInsert } = vi.hoisted((): Hoisted => ({
	state: { user: "u-editor" },
	dbUpdate: { set: vi.fn(), where: vi.fn(), rows: [] },
	stored: { row: null },
	dbInsert: { conflict: vi.fn(), rows: [] },
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
// The service-role db, answering each SELECT from fixtures by reading the predicate's bound params:
// the member table (read by `isActiveOrgMember`) holds each user in their home org only, so the
// outsider has no row in org A; environments are found only under the project the query names; identities only
// when the predicate's tenancy admits them. The update chain records what `updateProjectComponent`
// writes.
vi.mock("@/lib/db", async () => {
	const { cloudIdentities, member, projectCluster, projectDatabases, projectEnvironments } = await import(
		"@/lib/db/schema"
	);
	const { PgDialect: Dialect } = await import("drizzle-orm/pg-core");
	/** The rows a SELECT on `table` filtered by `predicate` returns, from the fixtures above. */
	const rowsFor = (table: unknown, predicate: SQL): unknown[] => {
		const params = new Dialect().sqlToQuery(predicate).params;
		if (table === member) {
			// and(userId = $1, organizationId = $2, status = 'active'): each user is a member of
			// their home org only.
			return USERS[String(params[0])]?.org === params[1] ? [{ id: `m-${String(params[0])}` }] : [];
		}
		if (table === projectEnvironments) {
			// and(project_id = $1, or(id/name/stage = …))
			return ENVS.filter(
				(e) => e.project_id === params[0] && params.slice(1).some((p) => p === e.id || p === e.name || p === e.stage),
			);
		}
		if (table === cloudIdentities) {
			// actorIdentityWhere: id = $1 AND ((org_id = $2 AND scope = 'org') [OR (user_id = $4 AND scope = 'personal')])
			return IDENTITIES.filter(
				(i) =>
					i.id === params[0] &&
					((i.scope === "org" && i.org_id === params[1]) ||
						(params.length > 3 && i.scope === "personal" && i.user_id === params[3])),
			);
		}
		if (table === projectDatabases || table === projectCluster) return stored.row ? [stored.row] : [];
		return [];
	};
	return {
		getServiceDb: () => ({
			select: () => ({
				from: (table: unknown) => ({
					where: (predicate: SQL) => {
						const limit = async () => rowsFor(table, predicate);
						return { limit, orderBy: () => ({ limit }) };
					},
				}),
			}),
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
			// db.insert(t).values(v).onConflictDoUpdate({ set, setWhere }).returning() — a singleton upsert.
			insert: () => ({
				values: () => ({
					onConflictDoUpdate: (arg: { set: Record<string, unknown>; setWhere?: SQL }) => {
						dbInsert.conflict(arg);
						return { returning: async () => dbInsert.rows };
					},
				}),
			}),
		}),
	};
});
// Org-bound: the project exists in org A and nowhere else. The environment resolver is REAL, so an
// `?env=` naming another project's environment is refused by the query it actually runs.
vi.mock("@/lib/cli/resolve-project", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/cli/resolve-project")>();
	return {
		...actual,
		resolveCliProject: vi.fn(async (orgId: string) => (orgId === ORG_A ? { id: PROJECT_ID } : null)),
	};
});
vi.mock("@/lib/cli/project-components", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/cli/project-components")>();
	return { ...actual, updateProjectComponent: vi.fn(), insertProjectComponent: vi.fn() };
});

import { PATCH } from "@/app/api/cli/projects/[id]/components/[kind]/[name]/route";
import { POST } from "@/app/api/cli/projects/[id]/components/[kind]/route";
import {
	ComponentWriteRefusedError,
	insertProjectComponent,
	parseIfMatch,
	updateProjectComponent,
	validateComponentFields,
} from "@/lib/cli/project-components";
import { resolveCliProject } from "@/lib/cli/resolve-project";

const WIRE = {
	id: "c1",
	kind: "databases",
	name: "orders",
	status: "ACTIVE",
	cloud_identity_id: null,
	config: { engine: "postgres", max_capacity: 8 },
	updated_at: "2026-10-06T10:00:00.000Z",
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
	dbInsert.rows = [];
	stored.row = null;
	vi.mocked(updateProjectComponent).mockResolvedValue(WIRE);
	vi.mocked(insertProjectComponent).mockResolvedValue(WIRE);
});

describe("PATCH /api/cli/projects/:id/components/:kind/:name", () => {
	it("200: updates only the fields sent, in the caller's org and the ?env= environment", async () => {
		const res = await patch({ fields: { max_capacity: 8 } });

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ component: WIRE });
		expect(resolveCliProject).toHaveBeenCalledWith(ORG_A, PROJECT_ID);
		expect(updateProjectComponent).toHaveBeenCalledWith(
			"databases",
			PROJECT_ID,
			ENV_ID,
			"orders",
			{ max_capacity: 8 },
			{ ifMatch: null },
		);
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
		const res = await patch({ fields: { max_capacity: 8 } }, { env: "qa" });
		expect(res.status).toBe(404);
		expect(updateProjectComponent).not.toHaveBeenCalled();
	});

	it("404: ?env= naming ANOTHER project's environment is refused, by id", async () => {
		const res = await patch({ fields: { max_capacity: 8 } }, { env: OTHER_ENV_ID });
		expect(res.status).toBe(404);
		expect(updateProjectComponent).not.toHaveBeenCalled();
	});

	it("?env=prod resolves to THIS project's prod, never the other project's of the same name", async () => {
		await patch({ fields: { max_capacity: 8 } });
		expect(updateProjectComponent).toHaveBeenCalledWith(
			"databases",
			PROJECT_ID,
			ENV_ID,
			"orders",
			{ max_capacity: 8 },
			{ ifMatch: null },
		);
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

/** Calls POST .../components/:kind as `alethia project component add` would. */
function post(kind: string, body: unknown) {
	return POST(
		new Request(`https://console.local/api/cli/projects/${PROJECT_ID}/components/${kind}?env=prod`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
			body: JSON.stringify(body),
		}),
		{ params: Promise.resolve({ id: PROJECT_ID, kind }) },
	);
}

// The cloud identity a component names is bound to the caller's org, like the project: on both
// write routes, a foreign identity is "not found" and nothing is written.
describe("cloud_identity_id is bound to the caller's org", () => {
	it.each([
		["another org's identity", IDENTITY_B],
		["another member's personal identity", IDENTITY_A_SOMEONE_ELSES],
		["an identity that does not exist", "e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e5"],
	])("PATCH 404s %s", async (_label, identity) => {
		const res = await patch({ fields: { cloud_identity_id: identity } });
		expect(res.status).toBe(404);
		expect((await res.json()).error).toBe("Cloud identity not found");
		expect(updateProjectComponent).not.toHaveBeenCalled();
	});

	it.each([
		["another org's identity", IDENTITY_B],
		["another member's personal identity", IDENTITY_A_SOMEONE_ELSES],
	])("POST 404s %s", async (_label, identity) => {
		const res = await post("databases", { name: "orders", fields: { cloud_identity_id: identity } });
		expect(res.status).toBe(404);
		expect((await res.json()).error).toBe("Cloud identity not found");
		expect(insertProjectComponent).not.toHaveBeenCalled();
	});

	it.each([
		["the org's identity", IDENTITY_A],
		["the caller's own personal identity", IDENTITY_A_MINE],
		["null, to re-inherit the project's", null],
	])("PATCH and POST accept %s", async (_label, identity) => {
		expect((await patch({ fields: { cloud_identity_id: identity } })).status).toBe(200);
		expect(updateProjectComponent).toHaveBeenCalledTimes(1);
		expect((await post("databases", { name: "orders", fields: { cloud_identity_id: identity } })).status).toBe(201);
		expect(insertProjectComponent).toHaveBeenCalledTimes(1);
	});

	it("a SERVICE token cannot use a personal identity, even its minter's", async () => {
		const { verifyCliToken } = await import("@/lib/cli/auth");
		vi.mocked(verifyCliToken).mockResolvedValueOnce({
			payload: { sub: "u-editor", service_token_org_id: ORG_A, service_token_id: "st-1" },
			error: null,
		});
		const res = await patch({ fields: { cloud_identity_id: IDENTITY_A_MINE } });
		expect(res.status).toBe(404);
		expect(updateProjectComponent).not.toHaveBeenCalled();
	});
});

// Why `apply` sends a singleton ONLY the fields that changed: the server's one-writer rule turns a
// cluster write that names `node_size` into one that also clears `instance_types`. A write that
// does not name either sizing field leaves both alone, so an unchanged size must not be re-sent.
describe("the cluster's sizing one-writer rule, as the add route applies it", () => {
	it("a write without node_size touches neither sizing field", () => {
		const r = validateComponentFields("cluster", { node_max_size: 5 });
		expect(r).toEqual({ ok: true, values: { node_max_size: 5 } });
	});

	it("a write that re-sends node_size clears instance_types", () => {
		const r = validateComponentFields("cluster", { node_size: { vcpu: 4, memory_gb: 16 }, node_max_size: 5 });
		expect(r.ok && r.values.instance_types).toEqual([]);
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
		// The status gate rides the same WHERE (#5551); no If-Match, so no revision condition.
		expect(sql).toMatch(/"status" not in/);
		expect(sql).not.toMatch(/date_trunc/);
		expect(params).toEqual([PROJECT_ID, ENV_ID, "orders", "CREATING", "UPDATING", "DESTROYING"]);
		expect(wire).toEqual({
			id: "c1",
			kind: "databases",
			name: "orders",
			status: "ACTIVE",
			cloud_identity_id: null,
			config: { environment_id: ENV_ID, engine: "postgres", max_capacity: 8 },
			updated_at: null,
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

// #5551 — a write to an existing component is refused (409) while a run is acting on it, and, with
// `If-Match`, unless it is still at the revision the caller read.

const REV = "2026-10-06T10:00:00.000Z";
/** prod's orders as the server holds it — ACTIVE, at REV unless overridden. */
function storedOrders(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "c1",
		org_id: ORG_A,
		project_id: PROJECT_ID,
		environment_id: ENV_ID,
		name: "orders",
		status: "ACTIVE",
		engine: "postgres",
		max_capacity: 8,
		updated_at: new Date(REV),
		...extra,
	};
}

describe("PATCH: the precondition and the status gate (#5551)", () => {
	it("passes If-Match through as the revision, normalised — quotes and a weak prefix accepted", async () => {
		await patch({ fields: { max_capacity: 8 } }, { headers: { "If-Match": `W/"2026-10-06T12:00:00+02:00"` } });
		expect(updateProjectComponent).toHaveBeenCalledWith(
			"databases",
			PROJECT_ID,
			ENV_ID,
			"orders",
			{ max_capacity: 8 },
			{ ifMatch: REV },
		);
	});

	it("400: an If-Match that is not a revision is refused, never treated as no precondition", async () => {
		const res = await patch({ fields: { max_capacity: 8 } }, { headers: { "If-Match": `"v7"` } });
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/If-Match must be the component's revision/);
		expect(updateProjectComponent).not.toHaveBeenCalled();
	});

	it("409 component_changed: names the refusal and carries the server's copy", async () => {
		const now = { ...WIRE, config: { engine: "postgres", max_capacity: 16 }, updated_at: "2026-10-06T10:05:00.000Z" };
		vi.mocked(updateProjectComponent).mockRejectedValue(
			new ComponentWriteRefusedError({ reason: "changed", component: now }),
		);
		const res = await patch({ fields: { max_capacity: 8 } }, { headers: { "If-Match": REV } });
		expect(res.status).toBe(409);
		const body = await res.json();
		expect(body.code).toBe("component_changed");
		expect(body.status).toBe("ACTIVE");
		expect(body.component).toEqual(now);
		expect(body.error).toMatch(/databases\/orders changed on the server since it was read/);
	});

	it("409 component_busy: a component being provisioned is not changed", async () => {
		vi.mocked(updateProjectComponent).mockRejectedValue(
			new ComponentWriteRefusedError({ reason: "busy", status: "CREATING", component: { ...WIRE, status: "CREATING" } }),
		);
		const res = await patch({ fields: { max_capacity: 8 } });
		expect(res.status).toBe(409);
		const body = await res.json();
		expect(body.code).toBe("component_busy");
		expect(body.status).toBe("CREATING");
		expect(body.error).toMatch(/is CREATING: a component cannot be changed while it is being provisioned/);
	});
});

describe("POST: a singleton's upsert is guarded the same way (#5551)", () => {
	it("passes If-Match for a singleton, and ignores it for a named create", async () => {
		const send = (kind: string, body: unknown) =>
			POST(
				new Request(`https://console.local/api/cli/projects/${PROJECT_ID}/components/${kind}?env=prod`, {
					method: "POST",
					headers: { "Content-Type": "application/json", Authorization: "Bearer t", "If-Match": `"${REV}"` },
					body: JSON.stringify(body),
				}),
				{ params: Promise.resolve({ id: PROJECT_ID, kind }) },
			);
		expect((await send("cluster", { fields: { node_max_size: 5 } })).status).toBe(201);
		expect(insertProjectComponent).toHaveBeenLastCalledWith("cluster", PROJECT_ID, ENV_ID, "", { node_max_size: 5 }, {
			ifMatch: REV,
		});
		expect((await send("databases", { name: "orders", fields: {} })).status).toBe(201);
		expect(insertProjectComponent).toHaveBeenLastCalledWith("databases", PROJECT_ID, ENV_ID, "orders", {}, {
			ifMatch: null,
		});
	});

	it("409: a refused upsert answers with the conflict body", async () => {
		vi.mocked(insertProjectComponent).mockRejectedValue(
			new ComponentWriteRefusedError({ reason: "changed", component: null }),
		);
		const res = await post("cluster", { fields: { node_max_size: 5 } });
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({
			error: expect.stringMatching(/no longer exists/),
			code: "component_changed",
			status: null,
			component: null,
		});
	});

	it("400: an unreadable If-Match on a singleton", async () => {
		const res = await POST(
			new Request(`https://console.local/api/cli/projects/${PROJECT_ID}/components/cluster?env=prod`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t", "If-Match": "yesterday" },
				body: JSON.stringify({ fields: { node_max_size: 5 } }),
			}),
			{ params: Promise.resolve({ id: PROJECT_ID, kind: "cluster" }) },
		);
		expect(res.status).toBe(400);
		expect(insertProjectComponent).not.toHaveBeenCalled();
	});
});

describe("parseIfMatch", () => {
	it.each([
		[null, null],
		["", null],
		["*", null],
		[REV, REV],
		[`"${REV}"`, REV],
		[`W/"${REV}"`, REV],
	])("%s → %s", (header, ifMatch) => {
		expect(parseIfMatch(header)).toEqual({ ok: true, ifMatch });
	});
});

describe("the guarded writes, driven for real (#5551)", () => {
	/** The real module, past the route's mocks of it. */
	async function real() {
		return vi.importActual<typeof import("@/lib/cli/project-components")>("@/lib/cli/project-components");
	}

	it("update: an If-Match adds the revision to the UPDATE's own WHERE, at millisecond precision", async () => {
		dbUpdate.rows = [storedOrders({ updated_at: new Date("2026-10-06T10:05:00.000Z") })];
		const { updateProjectComponent: update } = await real();
		const wire = await update("databases", PROJECT_ID, ENV_ID, "orders", { max_capacity: 16 }, { ifMatch: REV });
		const predicate = dbUpdate.where.mock.calls[0]?.[0];
		if (!predicate) throw new Error("the update chain was not driven");
		const { sql, params } = new PgDialect().sqlToQuery(predicate);
		expect(sql).toMatch(/date_trunc\('milliseconds', .*"updated_at"\) = \$\d+::timestamptz/);
		expect(params).toContain(REV);
		// The response carries the NEW revision, which is what the next If-Match must name.
		expect(wire?.updated_at).toBe("2026-10-06T10:05:00.000Z");
	});

	it.each([
		["CREATING", /being provisioned/],
		["UPDATING", /being provisioned/],
		["DESTROYING", /being destroyed/],
	])("update: a row %s is refused as busy", async (status, message) => {
		stored.row = storedOrders({ status });
		const { updateProjectComponent: update } = await real();
		const err = await update("databases", PROJECT_ID, ENV_ID, "orders", { max_capacity: 16 }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ComponentWriteRefusedError);
		if (!(err instanceof ComponentWriteRefusedError)) return;
		expect(err.refusal).toMatchObject({ reason: "busy", status });
		expect(err.message).toMatch(message);
	});

	it("update: a row at another revision is refused as changed, with the server's copy", async () => {
		stored.row = storedOrders({ max_capacity: 16, updated_at: new Date("2026-10-06T10:05:00.000Z") });
		const { updateProjectComponent: update } = await real();
		const err = await update("databases", PROJECT_ID, ENV_ID, "orders", { max_capacity: 4 }, { ifMatch: REV }).catch(
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(ComponentWriteRefusedError);
		if (!(err instanceof ComponentWriteRefusedError)) return;
		expect(err.refusal.reason).toBe("changed");
		expect(err.refusal.component).toMatchObject({
			name: "orders",
			config: { max_capacity: 16 },
			updated_at: "2026-10-06T10:05:00.000Z",
		});
	});

	it("update: no row at all is still the 404, not a refusal", async () => {
		const { updateProjectComponent: update } = await real();
		expect(await update("databases", PROJECT_ID, ENV_ID, "orders", { max_capacity: 4 }, { ifMatch: REV })).toBeNull();
	});

	it("singleton: an If-Match is an UPDATE of the row read, never an insert, and moves updated_at", async () => {
		dbUpdate.rows = [{ ...storedOrders(), name: undefined, node_max_size: 5 }];
		const { insertProjectComponent: upsert } = await real();
		await upsert("cluster", PROJECT_ID, ENV_ID, "", { node_max_size: 5 }, { ifMatch: REV });
		expect(dbInsert.conflict).not.toHaveBeenCalled();
		const set = dbUpdate.set.mock.calls[0]?.[0];
		expect(set?.node_max_size).toBe(5);
		expect(set?.updated_at).toBeInstanceOf(Date);
		const predicate = dbUpdate.where.mock.calls[0]?.[0];
		if (!predicate) throw new Error("the update chain was not driven");
		expect(new PgDialect().sqlToQuery(predicate).sql).toMatch(/date_trunc/);
	});

	it("singleton: an If-Match on a singleton removed since the read is refused, not re-created", async () => {
		const { insertProjectComponent: upsert } = await real();
		const err = await upsert("cluster", PROJECT_ID, ENV_ID, "", { node_max_size: 5 }, { ifMatch: REV }).catch(
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(ComponentWriteRefusedError);
		expect(dbInsert.conflict).not.toHaveBeenCalled();
	});

	it("singleton: the unconditional upsert carries the status gate on its conflict arm and moves updated_at", async () => {
		dbInsert.rows = [{ id: "k1", status: "ACTIVE", node_max_size: 5 }];
		const { insertProjectComponent: upsert } = await real();
		await upsert("cluster", PROJECT_ID, ENV_ID, "", { node_max_size: 5 });
		const arg = dbInsert.conflict.mock.calls[0]?.[0];
		if (!arg?.setWhere) throw new Error("the conflict arm carries no guard");
		expect(new PgDialect().sqlToQuery(arg.setWhere).sql).toMatch(/"status" not in/);
		expect(arg.set.updated_at).toBeInstanceOf(Date);
	});

	it("singleton: an upsert whose conflict arm the gate refused reads back as busy", async () => {
		stored.row = { ...storedOrders({ status: "DESTROYING" }), name: undefined };
		const { insertProjectComponent: upsert } = await real();
		const err = await upsert("cluster", PROJECT_ID, ENV_ID, "", { node_max_size: 5 }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ComponentWriteRefusedError);
		if (!(err instanceof ComponentWriteRefusedError)) return;
		expect(err.refusal).toMatchObject({ reason: "busy", status: "DESTROYING" });
		expect(err.message).toMatch(/^cluster is DESTROYING/);
	});
});

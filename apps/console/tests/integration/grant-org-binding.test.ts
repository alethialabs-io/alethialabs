// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: a grant's references belong to the grant's own organization — its ROLE (a built-in
// role or one of the org's custom roles), a TEAM principal, and the scoped RESOURCE. Asserted at
// every layer that states it, against real Postgres:
//
//   1. the two write boundaries — `assignGrant` (server action) and `POST /api/cli/grants` —
//      refuse each kind with a named reason, and write nothing;
//   2. the `grants_org_binding` trigger refuses the same rows from any other writer, on INSERT and
//      on an UPDATE that re-points a reference;
//   3. the community PDP confers nothing from an ALLOW row that is already stored unbound (written
//      before the trigger), while a stored unbound DENY still excludes (fail-closed).
//
// Positive controls in every block: the same request naming this org's own role, team or resource
// is accepted, so a refusal cannot pass by refusing everything.

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Actor, Entitlements } from "@/lib/authz/types";

const h = vi.hoisted((): { cliActor: Actor | null } => ({ cliActor: null }));

// The CLI route authenticates a bearer token; the actor it resolves is injected here, and the rest
// of the route — its checks, the insert, the trigger — runs for real. `authorize` (the server
// action's gate) is NOT replaced.
vi.mock("@/lib/authz/guard", async (importOriginal) => {
	const real = await importOriginal<typeof import("@/lib/authz/guard")>();
	return {
		...real,
		authorizeCli: async () => {
			if (!h.cliActor) throw new Error("test: no CLI actor set");
			return { actor: h.cliActor };
		},
	};
});

import { POST } from "@/app/api/cli/grants/route";
import { assignGrant } from "@/app/server/actions/grants";
import { runWithActor } from "@/lib/authz/actor-context";
import { INSTANCE_TYPES } from "@/lib/authz/fga-hierarchy";
import { PostgresRbacPDP } from "@/lib/authz/postgres-rbac-pdp";
import { BUILTIN_ROLE_IDS } from "@/lib/authz/registry";
import { seedAuthz } from "@/lib/authz/seed";
import { ForbiddenError } from "@/lib/authz/types";
import { getServiceDb } from "@/lib/db";
import {
	authzActivityLog,
	grants,
	member,
	organization,
	projects,
	resourceHierarchy,
	role,
	rolePermission,
	team,
	teamMember,
	user,
} from "@/lib/db/schema";
import {
	describeIfDb,
	insertStoredGrants,
	purgeAuthzActivityLog,
	refusalText,
} from "./db";

const ORG_A = randomUUID();
const ORG_B = randomUUID();
const ADMIN = randomUUID(); // owner of A — every permission, so the ceiling never decides a case
const TARGET = randomUUID(); // an active member of A, the grantee
const READER = randomUUID(); // an active member of A whose decisions the PDP block asks about
const TEAM_A = randomUUID();
const TEAM_B = randomUUID();
const PROJ_A = randomUUID();
const PROJ_B = randomUUID();
const ROLE_A = randomUUID(); // custom role of A: project:view
const ROLE_B = randomUUID(); // custom role of B: project:view

const ENTITLEMENTS: Entitlements = {
	organizations: true,
	teams: true,
	sso: true,
	customRoles: true,
	activityExport: true,
	alerting: true,
	advancedAlerting: true,
	byoRunners: true,
	managedPools: true,
	quotas: {
		maxConcurrentJobs: null,
		priorityLevel: 30,
		includedRunnerMinutes: 0,
		activityRetentionDays: 365,
	},
};

const admin: Actor = { userId: ADMIN, orgId: ORG_A, entitlements: ENTITLEMENTS, credential: "session" };

/** The grants in A whose principal is `principalId`. */
async function grantsOf(principalId: string): Promise<(typeof grants.$inferSelect)[]> {
	return getServiceDb()
		.select()
		.from(grants)
		.where(and(eq(grants.org_id, ORG_A), eq(grants.principal_id, principalId)));
}

/** Runs `assignGrant` as A's owner and returns the ForbiddenError reason it threw, or "ok". */
async function assignAsAdmin(input: Record<string, unknown>): Promise<string> {
	try {
		await runWithActor(admin, () => assignGrant(input));
		return "ok";
	} catch (err) {
		if (err instanceof ForbiddenError) return err.reason ?? "forbidden";
		throw err;
	}
}

/** POSTs a grant to the CLI route as A's owner. */
async function postAsAdmin(body: Record<string, unknown>): Promise<Response> {
	h.cliActor = admin;
	return POST(
		new Request("http://localhost/api/cli/grants", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
}

/** One project row in `orgId`, with its hierarchy edge. */
async function seedProject(id: string, orgId: string): Promise<void> {
	const db = getServiceDb();
	await db.insert(projects).values({
		id,
		user_id: orgId,
		org_id: orgId,
		project_name: `bind-${id.slice(0, 6)}`,
		region: "eu-west-1",
		iac_version: "1.0.0",
	});
	await db.insert(resourceHierarchy).values({
		child_type: "project",
		child_id: id,
		parent_type: "org",
		parent_id: orgId,
	});
}

describeIfDb("a grant's role, team and resource belong to the grant's org", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		await seedAuthz();
		await db.insert(user).values([
			{ id: ADMIN, email: `it-bind-admin-${ADMIN}@example.test` },
			{ id: TARGET, email: `it-bind-target-${TARGET}@example.test` },
			{ id: READER, email: `it-bind-reader-${READER}@example.test` },
		]);
		await db.insert(organization).values([
			{ id: ORG_A, name: `bind-a-${ORG_A.slice(0, 8)}` },
			{ id: ORG_B, name: `bind-b-${ORG_B.slice(0, 8)}` },
		]);
		await db.insert(member).values([
			{ organizationId: ORG_A, userId: ADMIN, role: "owner" },
			{ organizationId: ORG_A, userId: TARGET, role: "viewer" },
			{ organizationId: ORG_A, userId: READER, role: "viewer" },
		]);
		await db.insert(team).values([
			{ id: TEAM_A, name: "platform-a", organizationId: ORG_A },
			{ id: TEAM_B, name: "platform-b", organizationId: ORG_B },
		]);
		await db.insert(teamMember).values([
			{ teamId: TEAM_A, userId: READER },
			{ teamId: TEAM_B, userId: READER },
		]);
		await seedProject(PROJ_A, ORG_A);
		await seedProject(PROJ_B, ORG_B);
		await db.insert(role).values([
			{ id: ROLE_A, organization_id: ORG_A, name: `a-${ROLE_A.slice(0, 6)}`, is_builtin: false },
			{ id: ROLE_B, organization_id: ORG_B, name: `b-${ROLE_B.slice(0, 6)}`, is_builtin: false },
		]);
		await db.insert(rolePermission).values([
			{ role_id: ROLE_A, permission_key: "project:view" },
			{ role_id: ROLE_B, permission_key: "project:view" },
		]);
		await db.insert(grants).values({
			org_id: ORG_A,
			principal_type: "user",
			principal_id: ADMIN,
			role_id: BUILTIN_ROLE_IDS.owner,
			resource_type: "org",
		});
	});

	afterEach(async () => {
		// Everything but the owner's own grant.
		await getServiceDb()
			.delete(grants)
			.where(
				and(
					inArray(grants.org_id, [ORG_A, ORG_B]),
					inArray(grants.principal_id, [TARGET, READER, TEAM_A, TEAM_B]),
				),
			);
		h.cliActor = null;
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(grants).where(inArray(grants.org_id, [ORG_A, ORG_B]));
		await purgeAuthzActivityLog(inArray(authzActivityLog.org_id, [ORG_A, ORG_B]));
		await db.delete(rolePermission).where(inArray(rolePermission.role_id, [ROLE_A, ROLE_B]));
		await db.delete(role).where(inArray(role.id, [ROLE_A, ROLE_B]));
		await db.delete(resourceHierarchy).where(inArray(resourceHierarchy.child_id, [PROJ_A, PROJ_B]));
		await db.delete(projects).where(inArray(projects.id, [PROJ_A, PROJ_B]));
		await db.delete(teamMember).where(inArray(teamMember.teamId, [TEAM_A, TEAM_B]));
		await db.delete(team).where(inArray(team.id, [TEAM_A, TEAM_B]));
		await db.delete(member).where(inArray(member.organizationId, [ORG_A, ORG_B]));
		await db.delete(organization).where(inArray(organization.id, [ORG_A, ORG_B]));
		await db.delete(user).where(inArray(user.id, [ADMIN, TARGET, READER]));
	});

	describe("assignGrant (server action)", () => {
		it("refuses another org's role, as allow and as deny, and writes nothing", async () => {
			for (const effect of ["allow", "deny"]) {
				expect(
					await assignAsAdmin({
						principalType: "user",
						principalId: TARGET,
						effect,
						roleId: ROLE_B,
						resourceType: "org",
					}),
				).toBe("foreign_role");
			}
			expect(await grantsOf(TARGET)).toEqual([]);
		});

		it("refuses a scope on another org's project, and on an id that names nothing", async () => {
			for (const resourceId of [PROJ_B, randomUUID()]) {
				expect(
					await assignAsAdmin({
						principalType: "user",
						principalId: TARGET,
						effect: "allow",
						permissionKey: "project:view",
						resourceType: "project",
						resourceId,
					}),
				).toBe("foreign_resource");
			}
			expect(await grantsOf(TARGET)).toEqual([]);
		});

		it("refuses another org's team as the principal", async () => {
			expect(
				await assignAsAdmin({
					principalType: "team",
					principalId: TEAM_B,
					effect: "allow",
					permissionKey: "project:view",
					resourceType: "org",
				}),
			).toBe("foreign_team");
			expect(await grantsOf(TEAM_B)).toEqual([]);
		});

		it("CONTROL: this org's custom role, a built-in role, its project and its team are accepted", async () => {
			const requests = [
				{ principalType: "user", principalId: TARGET, effect: "allow", roleId: ROLE_A, resourceType: "org" },
				{ principalType: "user", principalId: TARGET, effect: "allow", roleId: BUILTIN_ROLE_IDS.viewer, resourceType: "org" },
				{ principalType: "user", principalId: TARGET, effect: "allow", permissionKey: "project:view", resourceType: "project", resourceId: PROJ_A },
				{ principalType: "team", principalId: TEAM_A, effect: "allow", permissionKey: "project:view", resourceType: "org" },
			];
			for (const request of requests) expect(await assignAsAdmin(request)).toBe("ok");
			expect(await grantsOf(TARGET)).toHaveLength(3);
			expect(await grantsOf(TEAM_A)).toHaveLength(1);
		});
	});

	describe("POST /api/cli/grants", () => {
		it("refuses each foreign reference with 400 and its reason, and writes nothing", async () => {
			const cases: [Record<string, unknown>, string][] = [
				[{ principal_type: "user", principal_id: TARGET, role_id: ROLE_B }, "foreign_role"],
				[
					{ principal_type: "user", principal_id: TARGET, permission_key: "project:view", resource_type: "project", resource_id: PROJ_B },
					"foreign_resource",
				],
				[{ principal_type: "team", principal_id: TEAM_B, permission_key: "project:view" }, "foreign_team"],
			];
			for (const [body, reason] of cases) {
				const res = await postAsAdmin(body);
				expect(res.status).toBe(400);
				expect(await res.json()).toMatchObject({ reason });
			}
			expect(await grantsOf(TARGET)).toEqual([]);
			expect(await grantsOf(TEAM_B)).toEqual([]);
		});

		it("CONTROL: this org's role, project and team are accepted (201)", async () => {
			for (const body of [
				{ principal_type: "user", principal_id: TARGET, role_id: ROLE_A },
				{ principal_type: "user", principal_id: TARGET, permission_key: "project:view", resource_type: "project", resource_id: PROJ_A },
				{ principal_type: "team", principal_id: TEAM_A, permission_key: "project:view" },
			]) {
				expect((await postAsAdmin(body)).status).toBe(201);
			}
			expect(await grantsOf(TARGET)).toHaveLength(2);
			expect(await grantsOf(TEAM_A)).toHaveLength(1);
		});
	});

	describe("the grants_org_binding trigger (any other writer)", () => {
		const base = {
			org_id: ORG_A,
			principal_type: "user",
			principal_id: TARGET,
			effect: "allow",
			resource_type: "org",
		};

		it("refuses a foreign role, team and resource on INSERT", async () => {
			const db = getServiceDb();
			expect(
				await refusalText(() => db.insert(grants).values({ ...base, role_id: ROLE_B })),
			).toContain("outside its organization (foreign_role)");
			expect(
				await refusalText(() =>
					db.insert(grants).values({
						...base,
						principal_type: "team",
						principal_id: TEAM_B,
						permission_key: "project:view",
					}),
				),
			).toContain("outside its organization (foreign_team)");
			expect(
				await refusalText(() =>
					db.insert(grants).values({
						...base,
						permission_key: "project:view",
						resource_type: "project",
						resource_id: PROJ_B,
					}),
				),
			).toContain("outside its organization (foreign_resource)");
		});

		it("refuses an unknown id for EVERY scopable kind — the SQL list is the hierarchy's", async () => {
			const refused: Record<string, boolean> = {};
			for (const kind of INSTANCE_TYPES) {
				const text = await refusalText(() =>
					getServiceDb()
						.insert(grants)
						.values({
							...base,
							permission_key: "project:view",
							resource_type: kind,
							resource_id: randomUUID(),
						}),
				);
				refused[kind] = text.includes("(foreign_resource)");
			}
			// Keyed by kind, so a failure names the kind the SQL list is missing.
			expect(refused).toEqual(Object.fromEntries(INSTANCE_TYPES.map((k) => [k, true])));
		});

		it("refuses an UPDATE that re-points an in-org grant at another org's role", async () => {
			const db = getServiceDb();
			const [row] = await db
				.insert(grants)
				.values({ ...base, role_id: ROLE_A })
				.returning({ id: grants.id });
			expect(
				await refusalText(() =>
					db.update(grants).set({ role_id: ROLE_B }).where(eq(grants.id, row.id)),
				),
			).toContain("(foreign_role)");
		});

		it("refuses an UPDATE that turns a stored unbound DENY into an ALLOW", async () => {
			await insertStoredGrants([{ ...base, effect: "deny", role_id: ROLE_B }]);
			expect(
				await refusalText(() =>
					getServiceDb()
						.update(grants)
						.set({ effect: "allow" })
						.where(and(eq(grants.org_id, ORG_A), eq(grants.role_id, ROLE_B))),
				),
			).toContain("(foreign_role)");
		});

		it("CONTROL: in-org rows, a built-in role and the org itself as a scope are accepted", async () => {
			await getServiceDb()
				.insert(grants)
				.values([
					{ ...base, role_id: ROLE_A },
					{ ...base, role_id: BUILTIN_ROLE_IDS.viewer },
					{ ...base, principal_type: "team", principal_id: TEAM_A, permission_key: "project:view" },
					{ ...base, permission_key: "project:view", resource_type: "project", resource_id: PROJ_A },
					{ ...base, permission_key: "project:view", resource_type: "project", resource_id: ORG_A },
				]);
			expect(await grantsOf(TARGET)).toHaveLength(4);
		});
	});

	describe("the community PDP ignores a STORED unbound allow row", () => {
		const pdp = new PostgresRbacPDP();
		const reader: Actor = { userId: READER, orgId: ORG_A, credential: "session" };
		const stored = {
			org_id: ORG_A,
			principal_type: "user",
			principal_id: READER,
			effect: "allow",
			resource_type: "org",
		};

		it("another org's role confers nothing; CONTROL: this org's role does", async () => {
			await insertStoredGrants([{ ...stored, role_id: ROLE_B }]);
			expect((await pdp.can(reader, "view", { type: "project", id: PROJ_A })).allowed).toBe(false);

			await insertStoredGrants([{ ...stored, role_id: ROLE_A }]);
			expect((await pdp.can(reader, "view", { type: "project", id: PROJ_A })).allowed).toBe(true);
		});

		it("a scope on another org's project confers nothing on that id", async () => {
			await insertStoredGrants([
				{ ...stored, permission_key: "project:view", resource_type: "project", resource_id: PROJ_B },
			]);
			expect((await pdp.can(reader, "view", { type: "project", id: PROJ_B })).allowed).toBe(false);
			expect(await pdp.listAccessible(reader, "view", "project")).toEqual([]);
		});

		it("another org's team confers nothing; CONTROL: this org's team does", async () => {
			await insertStoredGrants([
				{ ...stored, principal_type: "team", principal_id: TEAM_B, permission_key: "project:view" },
			]);
			expect((await pdp.can(reader, "view", { type: "project", id: PROJ_A })).allowed).toBe(false);

			await insertStoredGrants([
				{ ...stored, principal_type: "team", principal_id: TEAM_A, permission_key: "project:view" },
			]);
			expect((await pdp.can(reader, "view", { type: "project", id: PROJ_A })).allowed).toBe(true);
		});

		it("a stored unbound DENY still excludes (fail-closed)", async () => {
			await insertStoredGrants([
				{ ...stored, role_id: BUILTIN_ROLE_IDS.viewer },
				{ ...stored, effect: "deny", role_id: ROLE_B },
			]);
			const d = await pdp.can(reader, "view", { type: "project", id: PROJ_A });
			expect(d.allowed).toBe(false);
			expect(d.reason).toBe("explicit_deny");
		});
	});
});

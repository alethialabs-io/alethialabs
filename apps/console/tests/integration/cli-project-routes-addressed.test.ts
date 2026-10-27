// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// CLI PROJECT ROUTES CHECK THE ADDRESSED PROJECT, against real Postgres and the edition's PDP.
//
// A route under `app/api/cli/projects/[id]/` first asks `authorizeCli` the org-wide question (may
// this caller act on projects in this org at all?) and then, through
// `resolveCliProjectAuthorized` (lib/cli/project-access.ts), the same action about THE project it
// resolved. Routes that reach a project another way (by configuration name, by cluster id) ask the
// same question with the project id they found (`cliMayActOnProject`), and the two lists filter on
// the projects the caller may view (`cliViewableProjectIds`). This file drives:
//
//   - `GET  /api/cli/projects/[id]/cost`                               — `view`
//   - `POST /api/cli/projects/[id]/environments`                       — `edit`
//   - `GET  /api/cli/configurations/[name]` and `…/by-project-name/[project_name]` — `view`
//   - `GET  /api/cli/clusters/[id]`                                    — `view` of its project
//   - `GET  /api/cli/configurations` and `GET /api/cli/clusters`       — the lists
//
// A refusal is recorded: it leaves a `decision = false` activity row naming the project.
//
// One org, two projects (P and Q), four members. VIEWER and OPERATOR hold their role across the
// org; VIEW_DENIED is a viewer with an explicit deny on viewing P; EDIT_DENIED is an operator with an
// explicit deny on editing P. For each route the claim is: the member with the deny gets the same
// `404 Project not found` an absent project gets, for P only, and the write does not happen; the
// same member is served Q; the member without the deny is served P.
//
// It runs in whichever edition the job sets (CI runs both), so every grant and hierarchy edge is
// written the way the app writes it: the Postgres row, then its tuple mirror.
//
// WHAT IS MOCKED: only the CLI guard's credential resolution (`authorizeCli`, to the caller named
// by the test) — the bearer token is the input here, not the unit. Every permission question the
// route asks after that goes to the real PDP.
//
// What this does NOT cover: every other route under `app/api/cli/projects/[id]/`. That they all go
// through the same helper is held structurally by tests/app/api/cli/project-routes-addressed.test.ts.
// Nor does it check that an ALLOW writes no second row; the helper's code is the claim there.

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ user: "", org: "" }));
vi.mock("@/lib/authz/guard", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/authz/guard")>()),
	authorizeCli: async () => ({
		actor: { userId: h.user, orgId: h.org },
		credential: "session",
		orgScope: [h.org, h.user],
	}),
}));

import { GET as cliCluster } from "@/app/api/cli/clusters/[id]/route";
import { GET as cliClusters } from "@/app/api/cli/clusters/route";
import { GET as cliConfigByName } from "@/app/api/cli/configurations/[name]/route";
import { GET as cliConfigByProjectName } from "@/app/api/cli/configurations/by-project-name/[project_name]/route";
import { GET as cliConfigurations } from "@/app/api/cli/configurations/route";
import { GET as cliCost } from "@/app/api/cli/projects/[id]/cost/route";
import { POST as cliAddEnvironment } from "@/app/api/cli/projects/[id]/environments/route";
import { ensureMemberGrant } from "@/lib/authz/grants";
import { seedAuthz } from "@/lib/authz/seed";
import { getTupleSync } from "@/lib/authz/tuple-sync";
import { getServiceDb } from "@/lib/db";
import {
	authzActivityLog,
	grants,
	member,
	organization,
	projectCluster,
	projectEnvironments,
	projects,
	resourceHierarchy,
	user,
} from "@/lib/db/schema";
import { editionState } from "@/lib/enterprise";
import { describeIfDb, purgeAuthzActivityLog } from "./db";

const ORG = randomUUID();
const ADMIN = randomUUID(); // authors the projects; never calls a route
const VIEWER = randomUUID();
const VIEW_DENIED = randomUUID(); // viewer, explicitly denied viewing P
const OPERATOR = randomUUID();
const EDIT_DENIED = randomUUID(); // operator, explicitly denied editing P
const USERS = [ADMIN, VIEWER, VIEW_DENIED, OPERATOR, EDIT_DENIED];
const P = randomUUID();
const Q = randomUUID();
const NAME = { [P]: `it-cli-addressed-p-${P.slice(0, 8)}`, [Q]: `it-cli-addressed-q-${Q.slice(0, 8)}` };
const CLUSTER = { [P]: "", [Q]: "" };

/** Acts as `userId` in the org for the next CLI call. */
function actAs(userId: string): void {
	h.user = userId;
	h.org = ORG;
}

/** `GET /api/cli/projects/:projectId/cost` as `userId` → status and body. */
async function cost(userId: string, projectId: string) {
	actAs(userId);
	const res = await cliCost(
		new Request(`https://console.test/api/cli/projects/${projectId}/cost`),
		{ params: Promise.resolve({ id: projectId }) },
	);
	return { status: res.status, body: await res.json() };
}

/** `POST /api/cli/projects/:projectId/environments` as `userId`, adding `name` → status and body. */
async function addEnvironment(userId: string, projectId: string, name: string) {
	actAs(userId);
	const res = await cliAddEnvironment(
		new Request(`https://console.test/api/cli/projects/${projectId}/environments`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name, placement_mode: "dedicated" }),
		}),
		{ params: Promise.resolve({ id: projectId }) },
	);
	return { status: res.status, body: await res.json() };
}

/** The environment names project `projectId` holds. */
async function environmentNames(projectId: string): Promise<string[]> {
	const rows = await getServiceDb()
		.select({ name: projectEnvironments.name })
		.from(projectEnvironments)
		.where(eq(projectEnvironments.project_id, projectId));
	return rows.map((r) => r.name);
}

/** A GET of `path` as `userId` through `route` → status and body. */
async function getAs<C>(
	userId: string,
	route: (req: Request, ctx: C) => Promise<Response>,
	path: string,
	ctx: C,
) {
	actAs(userId);
	const res = await route(new Request(`https://console.test${path}`), ctx);
	return { status: res.status, body: await res.json() };
}

/** The configuration read by name, as `userId`, through both routes that serve it → statuses. */
async function configStatuses(userId: string, projectId: string): Promise<number[]> {
	const name = NAME[projectId] ?? projectId;
	const byName = await getAs(userId, cliConfigByName, `/api/cli/configurations/${name}`, {
		params: Promise.resolve({ name }),
	});
	const byProjectName = await getAs(
		userId,
		cliConfigByProjectName,
		`/api/cli/configurations/by-project-name/${name}`,
		{ params: Promise.resolve({ project_name: name }) },
	);
	return [byName.status, byProjectName.status];
}

/** `GET /api/cli/clusters/:id` for project `projectId`'s cluster, as `userId` → status. */
async function clusterStatus(userId: string, projectId: string): Promise<number> {
	const id = CLUSTER[projectId] ?? projectId;
	return (await getAs(userId, cliCluster, `/api/cli/clusters/${id}`, { params: Promise.resolve({ id }) }))
		.status;
}

/** The project ids `GET /api/cli/configurations` lists for `userId`. */
async function listedConfigurations(userId: string): Promise<string[]> {
	actAs(userId);
	const res = await cliConfigurations(new Request("https://console.test/api/cli/configurations"));
	expect(res.status).toBe(200);
	const body: unknown = await res.json();
	if (typeof body !== "object" || body === null || !("configurations" in body) || !Array.isArray(body.configurations)) {
		throw new Error(`unexpected body: ${JSON.stringify(body)}`);
	}
	return body.configurations.flatMap((c: unknown) =>
		typeof c === "object" && c !== null && "id" in c && typeof c.id === "string" ? [c.id] : [],
	);
}

/** The cluster ids `GET /api/cli/clusters` lists for `userId`. */
async function listedClusters(userId: string): Promise<string[]> {
	actAs(userId);
	const res = await cliClusters(new Request("https://console.test/api/cli/clusters"));
	expect(res.status).toBe(200);
	const body: unknown = await res.json();
	if (typeof body !== "object" || body === null || !("clusters" in body) || !Array.isArray(body.clusters)) {
		throw new Error(`unexpected body: ${JSON.stringify(body)}`);
	}
	return body.clusters.flatMap((c: unknown) =>
		typeof c === "object" && c !== null && "id" in c && typeof c.id === "string" ? [c.id] : [],
	);
}

/** The refusals recorded for `userId` doing `action` on project P. */
async function refusalsOnP(userId: string, action: string) {
	return getServiceDb()
		.select({ id: authzActivityLog.id })
		.from(authzActivityLog)
		.where(
			and(
				eq(authzActivityLog.org_id, ORG),
				eq(authzActivityLog.actor_id, userId),
				eq(authzActivityLog.action, action),
				eq(authzActivityLog.resource_type, "project"),
				eq(authzActivityLog.resource_id, P),
				eq(authzActivityLog.decision, false),
			),
		);
}

/** Writes an explicit deny of `permissionKey` on project P for `userId`: the row, then its mirror. */
async function denyOnP(userId: string, permissionKey: "project:view" | "project:edit") {
	await getServiceDb().insert(grants).values({
		org_id: ORG,
		principal_type: "user",
		principal_id: userId,
		effect: "deny",
		permission_key: permissionKey,
		resource_type: "project",
		resource_id: P,
	});
	await getTupleSync().syncScopedGrant({
		orgId: ORG,
		principalType: "user",
		principalId: userId,
		effect: "deny",
		resourceType: "project",
		resourceId: P,
		roleId: null,
		permissionKey,
	});
}

const NOT_FOUND = { error: "Project not found" };

describeIfDb("CLI project routes check the addressed project", () => {
	beforeAll(async () => {
		// The edition is a premise: a broken enterprise load must fail here rather than answer on
		// the community engine.
		const state = editionState();
		const expected = process.env.ALETHIA_EDITION === "enterprise" ? "enterprise" : "community";
		if (state.kind !== expected) {
			throw new Error(
				`the ${expected} edition did not load (${JSON.stringify(state)}); this suite would measure another engine`,
			);
		}

		const db = getServiceDb();
		await seedAuthz();
		await db
			.insert(user)
			.values(USERS.map((id) => ({ id, email: `it-cli-addressed-${id}@example.test` })));
		await db.insert(organization).values({
			id: ORG,
			name: `it-cli-addressed-${ORG.slice(0, 8)}`,
			slug: `it-cli-addressed-${ORG.slice(0, 8)}`,
		});
		const roles: [string, string][] = [
			[ADMIN, "admin"],
			[VIEWER, "viewer"],
			[VIEW_DENIED, "viewer"],
			[OPERATOR, "operator"],
			[EDIT_DENIED, "operator"],
		];
		await db
			.insert(member)
			.values(roles.map(([userId, role]) => ({ organizationId: ORG, userId, role })));
		for (const [userId, role] of roles) await ensureMemberGrant(ORG, userId, role);
		await db.insert(projects).values(
			[P, Q].map((id) => ({
				id,
				user_id: ADMIN,
				org_id: ORG,
				project_name: NAME[id] ?? id,
				slug: NAME[id] ?? id,
				region: "eu-west-1",
				iac_version: "1.0.0",
			})),
		);
		// What creating a project writes beside it: the org → project edge, mirrored to the
		// enterprise PDP's store. A grant scoped to P is resolved through it.
		await db.insert(resourceHierarchy).values(
			[P, Q].map((id) => ({
				child_type: "project",
				child_id: id,
				parent_type: "org",
				parent_id: ORG,
			})),
		);
		for (const id of [P, Q]) {
			await getTupleSync().syncHierarchyEdge({
				childType: "project",
				childId: id,
				parentType: "org",
				parentId: ORG,
			});
		}
		// What creating a project also gives it: a default environment (a configuration is read
		// through it), and here a cluster each, so the cluster reads have rows to refuse.
		for (const id of [P, Q]) {
			await db
				.insert(projectEnvironments)
				.values({ project_id: id, user_id: ADMIN, org_id: ORG, name: "production", is_default: true });
			const [c] = await db
				.insert(projectCluster)
				.values({ project_id: id, cluster_name: `k8s-${id.slice(0, 8)}`, status: "ACTIVE" })
				.returning({ id: projectCluster.id });
			if (!c) throw new Error("cluster seed returned no row");
			CLUSTER[id] = c.id;
		}
		await denyOnP(VIEW_DENIED, "project:view");
		await denyOnP(EDIT_DENIED, "project:edit");
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(projectCluster).where(inArray(projectCluster.project_id, [P, Q]));
		await db.delete(projectEnvironments).where(inArray(projectEnvironments.project_id, [P, Q]));
		await db.delete(resourceHierarchy).where(eq(resourceHierarchy.parent_id, ORG));
		await db.delete(projects).where(eq(projects.org_id, ORG));
		await purgeAuthzActivityLog(inArray(authzActivityLog.org_id, [ORG]));
		await db.delete(grants).where(eq(grants.org_id, ORG));
		await db.delete(member).where(eq(member.organizationId, ORG));
		await db.delete(organization).where(eq(organization.id, ORG));
		await db.delete(user).where(inArray(user.id, USERS));
	});

	describe("a read — GET cost (view)", () => {
		it("answers P as not found for the member denied viewing P", async () => {
			expect(await cost(VIEW_DENIED, P)).toEqual({ status: 404, body: NOT_FOUND });
		});

		it("answers exactly as it answers a project that does not exist", async () => {
			expect(await cost(VIEW_DENIED, randomUUID())).toEqual({ status: 404, body: NOT_FOUND });
		});

		it("serves the same member every other project, and serves P to a member without the deny", async () => {
			expect((await cost(VIEW_DENIED, Q)).status).toBe(200);
			expect((await cost(VIEWER, P)).status).toBe(200);
		});
	});

	describe("a write — POST environments (edit)", () => {
		it("answers P as not found for the member denied editing P, and writes nothing", async () => {
			expect(await addEnvironment(EDIT_DENIED, P, "refused")).toEqual({
				status: 404,
				body: NOT_FOUND,
			});
			expect(await environmentNames(P)).not.toContain("refused");
		});

		it("records the refusal: a denied activity row naming P", async () => {
			// The activity write is fire-and-forget, so it is waited for rather than read once.
			await vi.waitFor(async () => {
				expect((await refusalsOnP(EDIT_DENIED, "edit")).length).toBeGreaterThan(0);
			});
		});

		it("adds the environment to Q for that member, and to P for a member without the deny", async () => {
			expect((await addEnvironment(EDIT_DENIED, Q, "allowed-q")).status).toBe(201);
			expect(await environmentNames(Q)).toContain("allowed-q");
			expect((await addEnvironment(OPERATOR, P, "allowed-p")).status).toBe(201);
			expect(await environmentNames(P)).toContain("allowed-p");
		});

		it("a deny on editing P leaves viewing P alone (the second question asks the route's own action)", async () => {
			// The second question asks the route's OWN action, not a blanket one: the operator denied
			// editing P still reads P.
			expect((await cost(EDIT_DENIED, P)).status).toBe(200);
		});
	});

	describe("routes that reach the project another way", () => {
		it("the configuration read by name answers P as not found for the member denied viewing P", async () => {
			expect(await configStatuses(VIEW_DENIED, P)).toEqual([404, 404]);
			expect(await configStatuses(VIEW_DENIED, Q)).toEqual([200, 200]);
			expect(await configStatuses(VIEWER, P)).toEqual([200, 200]);
		});

		it("the cluster read by id answers P's cluster as not found for that member", async () => {
			expect(await clusterStatus(VIEW_DENIED, P)).toBe(404);
			expect(await clusterStatus(VIEW_DENIED, Q)).toBe(200);
			expect(await clusterStatus(VIEWER, P)).toBe(200);
		});

		it("the lists leave P (and P's cluster) out for that member, and keep them for the others", async () => {
			const configs = await listedConfigurations(VIEW_DENIED);
			expect(configs).not.toContain(P);
			expect(configs).toContain(Q);
			expect(await listedConfigurations(VIEWER)).toEqual(expect.arrayContaining([P, Q]));

			const clusters = await listedClusters(VIEW_DENIED);
			expect(clusters).not.toContain(CLUSTER[P]);
			expect(clusters).toContain(CLUSTER[Q]);
			expect(await listedClusters(VIEWER)).toEqual(expect.arrayContaining([CLUSTER[P], CLUSTER[Q]]));
		});
	});
});

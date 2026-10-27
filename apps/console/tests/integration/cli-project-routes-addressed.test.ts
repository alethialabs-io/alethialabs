// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// CLI PROJECT ROUTES CHECK THE ADDRESSED PROJECT, against real Postgres and the edition's PDP.
//
// A route under `app/api/cli/projects/[id]/` first asks `authorizeCli` the org-wide question (may
// this caller act on projects in this org at all?) and then, through
// `resolveCliProjectAuthorized` (lib/cli/project-access.ts), the same action about THE project it
// resolved. This file drives one read and one write through that second question:
//
//   - `GET  /api/cli/projects/[id]/cost`          — `view`
//   - `POST /api/cli/projects/[id]/environments`  — `edit`
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

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
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
				project_name: `it-cli-addressed-${id.slice(0, 8)}`,
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
		await denyOnP(VIEW_DENIED, "project:view");
		await denyOnP(EDIT_DENIED, "project:edit");
	});

	afterAll(async () => {
		const db = getServiceDb();
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

		it("adds the environment to Q for that member, and to P for a member without the deny", async () => {
			expect((await addEnvironment(EDIT_DENIED, Q, "allowed-q")).status).toBe(201);
			expect(await environmentNames(Q)).toContain("allowed-q");
			expect((await addEnvironment(OPERATOR, P, "allowed-p")).status).toBe(201);
			expect(await environmentNames(P)).toContain("allowed-p");
		});

		it("a deny on editing P leaves viewing P alone", async () => {
			// The second question asks the route's OWN action, not a blanket one: the operator denied
			// editing P still reads P.
			expect((await cost(EDIT_DENIED, P)).status).toBe(200);
		});
	});
});

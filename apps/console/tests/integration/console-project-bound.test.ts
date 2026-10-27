// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// READS AND WRITES AUTHORIZED AT ORG LEVEL FOLLOW THE PROJECT THEIR ROWS NAME, against real Postgres
// and the edition's PDP.
//
// Some reads and writes are gated on the ORG, because what they touch is the org's — an agent
// identity, a classification value — while the row in question may name a PROJECT. A grant or deny
// scoped to that project is not part of an org-level answer, so each of these also asks about the
// project:
//
//   - the console's agent reads, `listAgents` / `getAgent` (app/server/actions/agents.ts) — `view`;
//   - classification on a project-owned resource, in the console (`getAssignments`,
//     `getAssignmentsForKind`, `assignClassification`, `unassignClassification`) and the CLI
//     (`GET` / `POST` / `DELETE /api/cli/classification/assignments`) — `view` to read, `edit` to
//     change (lib/classification/resource-project.ts).
//
// And the console's environment actions (app/server/actions/projects.ts), which are addressed by a
// project id the caller supplies: the writes (`addEnvironment`, `duplicateEnvironment`,
// `setAutoHeal`, `deleteEnvironment`) bind that project to the ADDRESSED organization before the PDP
// is asked (`assertProjectInActorOrg`), so a project of the caller's personal workspace is not
// reachable from a team-org address, and a project-level deny refuses them; the read
// (`getProjectEnvironments`) is refused for a member denied viewing the project.
//
// One org, two projects (P and Q). VIEWER and OPERATOR hold their role across the org; VIEW_DENIED is
// a viewer with an explicit deny on viewing P; EDIT_DENIED is an operator with an explicit deny on
// editing P. For each surface the claim is: the member with the deny gets what an absent row gets,
// for P only, and a write does not happen; the same member is served Q; a member without the deny is
// served P.
//
// RECORDING: a refused read (getAgent, getProjectEnvironments) and a refused write
// (assignClassification, setAutoHeal) each leave exactly ONE `decision = false` activity row naming P. Each counting test acts as a member no other test
// acts as, because a refusal's row is written fire-and-forget and a shared member's earlier row could
// land mid-count.
//
// It runs in whichever edition the job sets (CI runs both), so every grant and hierarchy edge is
// written the way the app writes it: the Postgres row, then its tuple mirror.
//
// WHAT IS MOCKED: only the CLI guard's credential resolution (`authorizeCli`, to the caller named by
// the test). The console actions run under an injected actor (`runWithActor`, the seam the MCP server
// uses). Every permission question after that goes to the real PDP.

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ user: "", org: "" }));
vi.mock("@/lib/authz/guard", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/authz/guard")>()),
	authorizeCli: async () => ({
		actor: { userId: h.user, orgId: h.org, credential: "session" },
		credential: "session",
		orgScope: [h.org, h.user],
	}),
}));

import {
	DELETE as cliUnassign,
	GET as cliAssignments,
	POST as cliAssign,
} from "@/app/api/cli/classification/assignments/route";
import { getAgent, listAgents } from "@/app/server/actions/agents";
import {
	addEnvironment,
	deleteEnvironment,
	duplicateEnvironment,
	getProjectEnvironments,
	setAutoHeal,
} from "@/app/server/actions/projects";
import {
	assignClassification,
	getAssignments,
	getAssignmentsForKind,
	unassignClassification,
} from "@/app/server/actions/classification/assignments";
import { runWithActor } from "@/lib/authz/actor-context";
import { ensureMemberGrant } from "@/lib/authz/grants";
import { seedAuthz } from "@/lib/authz/seed";
import { getTupleSync } from "@/lib/authz/tuple-sync";
import type { Actor } from "@/lib/authz/types";
import { getServiceDb } from "@/lib/db";
import {
	agentIdentities,
	authzActivityLog,
	classificationAssignment,
	classificationDimension,
	classificationValue,
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
const ADMIN = randomUUID(); // authors the projects; never calls anything
const VIEWER = randomUUID();
const VIEW_DENIED = randomUUID(); // viewer, explicitly denied viewing P
const OPERATOR = randomUUID();
const EDIT_DENIED = randomUUID(); // operator, explicitly denied editing P
// Each recording test acts as a member no other test uses (see the header).
const RECORD_VIEW = randomUUID(); // viewer, denied viewing P; used only by the agent-recording test
const RECORD_EDIT = randomUUID(); // operator, denied editing P; used only by the classification-recording test
const RECORD_ENV_VIEW = randomUUID(); // viewer, denied viewing P; used only by the environments-read recording test
const RECORD_ENV_EDIT = randomUUID(); // operator, denied editing P; used only by the environment-write recording test
const USERS = [ADMIN, VIEWER, VIEW_DENIED, OPERATOR, EDIT_DENIED, RECORD_VIEW, RECORD_EDIT, RECORD_ENV_VIEW, RECORD_ENV_EDIT];
const P = randomUUID();
const Q = randomUUID();
const NAME = { [P]: `it-proj-bound-p-${P.slice(0, 8)}`, [Q]: `it-proj-bound-q-${Q.slice(0, 8)}` };
/**
 * A project of OPERATOR's PERSONAL workspace (its org id is OPERATOR's user id). OPERATOR is also a
 * member of ORG, so from ORG's address the RLS owner arm still reaches it.
 */
const PERSONAL = randomUUID();
/** Each project's default environment, a classifiable resource that lives in the project. */
const ENV = { [P]: "", [Q]: "", [PERSONAL]: "" };
/** A second, non-default environment of each project (deletable). */
const SPARE = { [P]: "", [Q]: "", [PERSONAL]: "" };
/** Agent identities authored by ADMIN in ORG: one bound to P, one to Q, one to no project. */
const AGENT = { P: randomUUID(), Q: randomUUID(), NONE: randomUUID() };
/** A multi-valued dimension of ORG with two values: `seeded` (pre-assigned) and `added`. */
const DIM_KEY = `it-proj-bound-${ORG.slice(0, 8)}`;
const VALUE = { seeded: "", added: "" };

/** The console actor for `userId` in ORG. */
function actor(userId: string): Actor {
	return { credential: "session", userId, orgId: ORG };
}

/** Runs a console action as `userId` in ORG. */
function actingAs<T>(userId: string, fn: () => Promise<T>): Promise<T> {
	return runWithActor(actor(userId), fn);
}

/** Acts as `userId` in ORG for the next CLI call. */
function actAs(userId: string): void {
	h.user = userId;
	h.org = ORG;
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

/** How many `decision = false` activity rows name project P for `userId` doing `action`. */
async function refusalsOnP(userId: string, action: string): Promise<number> {
	const rows = await getServiceDb()
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
	return rows.length;
}

/**
 * Settles the fire-and-forget activity writes of the request just made: waits for `count()` to reach
 * `expected`, then waits a little longer and requires it to still BE `expected`.
 */
async function settlesAt(count: () => Promise<number>, expected: number): Promise<void> {
	await vi.waitFor(async () => expect(await count()).toBe(expected));
	await new Promise((r) => setTimeout(r, 300));
	expect(await count()).toBe(expected);
}

/** The value ids assigned to `resourceId` (any kind), read on the service role. */
async function assignedValues(resourceId: string): Promise<string[]> {
	const rows = await getServiceDb()
		.select({ value: classificationAssignment.value_id })
		.from(classificationAssignment)
		.where(and(eq(classificationAssignment.org_id, ORG), eq(classificationAssignment.resource_id, resourceId)));
	return rows.map((r) => r.value);
}

/** Pins `valueId` to `resourceId` of `kind` directly, as fixture state. */
async function pin(kind: "project" | "project_environment", resourceId: string, valueId: string, dimensionId: string) {
	await getServiceDb()
		.insert(classificationAssignment)
		.values({ org_id: ORG, dimension_id: dimensionId, value_id: valueId, resource_kind: kind, resource_id: resourceId, assigned_by: ADMIN })
		.onConflictDoNothing();
}

/** The `assignments` array of a CLI classification response. */
async function cliBodyAssignments(res: Response): Promise<unknown[]> {
	const body: unknown = await res.json();
	if (typeof body !== "object" || body === null || !("assignments" in body) || !Array.isArray(body.assignments)) {
		throw new Error(`unexpected body: ${JSON.stringify(body)}`);
	}
	return body.assignments;
}

/** `GET /api/cli/classification/assignments?kind=…&id=…` as `userId` → status and assignment count. */
async function cliRead(userId: string, kind: string, id: string) {
	actAs(userId);
	const res = await cliAssignments(
		new Request(`https://console.test/api/cli/classification/assignments?kind=${kind}&id=${id}`),
	);
	return { status: res.status, count: res.status === 200 ? (await cliBodyAssignments(res)).length : -1 };
}

/** `POST /api/cli/classification/assignments` pinning `added` to `id` as `userId` → status. */
async function cliPin(userId: string, kind: string, id: string): Promise<number> {
	actAs(userId);
	const res = await cliAssign(
		new Request("https://console.test/api/cli/classification/assignments", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ kind, id, dimension_key: DIM_KEY, value_slug: "added" }),
		}),
	);
	return res.status;
}

/** `DELETE /api/cli/classification/assignments` clearing `seeded` from `id` as `userId` → status. */
async function cliClear(userId: string, kind: string, id: string): Promise<number> {
	actAs(userId);
	const res = await cliUnassign(
		new Request(
			`https://console.test/api/cli/classification/assignments?kind=${kind}&id=${id}&value_slug=seeded`,
			{ method: "DELETE" },
		),
	);
	return res.status;
}

let dimensionId = "";

describeIfDb("org-level reads and writes follow the project their rows name", () => {
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
		await db.insert(user).values(USERS.map((id) => ({ id, email: `it-proj-bound-${id}@example.test` })));
		await db.insert(organization).values({
			id: ORG,
			name: `it-proj-bound-${ORG.slice(0, 8)}`,
			slug: `it-proj-bound-${ORG.slice(0, 8)}`,
		});
		const roles: [string, string][] = [
			[ADMIN, "admin"],
			[VIEWER, "viewer"],
			[VIEW_DENIED, "viewer"],
			[OPERATOR, "operator"],
			[EDIT_DENIED, "operator"],
			[RECORD_VIEW, "viewer"],
			[RECORD_EDIT, "operator"],
			[RECORD_ENV_VIEW, "viewer"],
			[RECORD_ENV_EDIT, "operator"],
		];
		await db.insert(member).values(roles.map(([userId, role]) => ({ organizationId: ORG, userId, role })));
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
		await db
			.insert(resourceHierarchy)
			.values([P, Q].map((id) => ({ child_type: "project", child_id: id, parent_type: "org", parent_id: ORG })));
		for (const id of [P, Q]) {
			await getTupleSync().syncHierarchyEdge({ childType: "project", childId: id, parentType: "org", parentId: ORG });
		}
		await db.insert(projects).values({
			id: PERSONAL,
			user_id: OPERATOR,
			org_id: OPERATOR,
			project_name: `it-proj-bound-personal-${PERSONAL.slice(0, 8)}`,
			slug: `it-proj-bound-personal-${PERSONAL.slice(0, 8)}`,
			region: "eu-west-1",
			iac_version: "1.0.0",
		});
		for (const id of [P, Q, PERSONAL]) {
			const author = id === PERSONAL ? OPERATOR : ADMIN;
			const org = id === PERSONAL ? OPERATOR : ORG;
			const [env] = await db
				.insert(projectEnvironments)
				.values({ project_id: id, user_id: author, org_id: org, name: "production", is_default: true })
				.returning({ id: projectEnvironments.id });
			const [spare] = await db
				.insert(projectEnvironments)
				.values({ project_id: id, user_id: author, org_id: org, name: "staging", is_default: false })
				.returning({ id: projectEnvironments.id });
			if (!env || !spare) throw new Error("environment seed returned no row");
			ENV[id] = env.id;
			SPARE[id] = spare.id;
		}
		await db.insert(agentIdentities).values(
			(
				[
					[AGENT.P, P],
					[AGENT.Q, Q],
					[AGENT.NONE, null],
				] as const
			).map(([id, projectId]) => ({
				id,
				user_id: ADMIN,
				org_id: ORG,
				project_id: projectId,
				persona: "it-agent",
				mission: "integration fixture",
				memory_namespace: `it-${id.slice(0, 8)}`,
			})),
		);
		const [dim] = await db
			.insert(classificationDimension)
			.values({ org_id: ORG, created_by: ADMIN, key: DIM_KEY, label: "Tier", multi: true })
			.returning({ id: classificationDimension.id });
		if (!dim) throw new Error("dimension seed returned no row");
		dimensionId = dim.id;
		for (const slug of ["seeded", "added"] as const) {
			const [v] = await db
				.insert(classificationValue)
				.values({ org_id: ORG, dimension_id: dim.id, value: slug, label: slug })
				.returning({ id: classificationValue.id });
			if (!v) throw new Error("value seed returned no row");
			VALUE[slug] = v.id;
		}
		for (const id of [P, Q]) {
			await pin("project", id, VALUE.seeded, dimensionId);
			await pin("project_environment", ENV[id] ?? "", VALUE.seeded, dimensionId);
		}
		await denyOnP(VIEW_DENIED, "project:view");
		await denyOnP(EDIT_DENIED, "project:edit");
		await denyOnP(RECORD_VIEW, "project:view");
		await denyOnP(RECORD_EDIT, "project:edit");
		await denyOnP(RECORD_ENV_VIEW, "project:view");
		await denyOnP(RECORD_ENV_EDIT, "project:edit");
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(classificationAssignment).where(eq(classificationAssignment.org_id, ORG));
		await db.delete(classificationValue).where(eq(classificationValue.org_id, ORG));
		await db.delete(classificationDimension).where(eq(classificationDimension.org_id, ORG));
		await db.delete(agentIdentities).where(eq(agentIdentities.org_id, ORG));
		await db.delete(projectEnvironments).where(inArray(projectEnvironments.project_id, [P, Q, PERSONAL]));
		await db.delete(resourceHierarchy).where(eq(resourceHierarchy.parent_id, ORG));
		await db.delete(projects).where(inArray(projects.id, [P, Q, PERSONAL]));
		await purgeAuthzActivityLog(inArray(authzActivityLog.org_id, [ORG]));
		await db.delete(grants).where(eq(grants.org_id, ORG));
		await db.delete(member).where(eq(member.organizationId, ORG));
		await db.delete(organization).where(eq(organization.id, ORG));
		await db.delete(user).where(inArray(user.id, USERS));
	});

	describe("console agent reads", () => {
		it("getAgent answers P's agent as absent for the member denied viewing P only", async () => {
			expect(await actingAs(VIEW_DENIED, () => getAgent(AGENT.P))).toBeNull();
			expect((await actingAs(VIEW_DENIED, () => getAgent(AGENT.Q)))?.id).toBe(AGENT.Q);
			expect((await actingAs(VIEW_DENIED, () => getAgent(AGENT.NONE)))?.id).toBe(AGENT.NONE);
			expect((await actingAs(VIEWER, () => getAgent(AGENT.P)))?.id).toBe(AGENT.P);
		});

		it("records that refusal: exactly one denied view row naming P", async () => {
			const refusals = () => refusalsOnP(RECORD_VIEW, "view");
			const before = await refusals();
			expect(await actingAs(RECORD_VIEW, () => getAgent(AGENT.P))).toBeNull();
			await settlesAt(refusals, before + 1);
		});

		it("listAgents leaves P's agent out for that member, and keeps it for the others", async () => {
			const denied = (await actingAs(VIEW_DENIED, () => listAgents())).map((a) => a.id);
			expect(denied).not.toContain(AGENT.P);
			expect(denied).toEqual(expect.arrayContaining([AGENT.Q, AGENT.NONE]));
			const viewer = (await actingAs(VIEWER, () => listAgents())).map((a) => a.id);
			expect(viewer).toEqual(expect.arrayContaining([AGENT.P, AGENT.Q, AGENT.NONE]));
		});
	});

	describe("console classification on a project-owned resource", () => {
		it("getAssignments answers P and P's environment with no chips for the member denied viewing P only", async () => {
			expect(await actingAs(VIEW_DENIED, () => getAssignments("project", P))).toEqual([]);
			expect(await actingAs(VIEW_DENIED, () => getAssignments("project_environment", ENV[P] ?? ""))).toEqual([]);
			expect((await actingAs(VIEW_DENIED, () => getAssignments("project", Q))).length).toBeGreaterThan(0);
			expect(await actingAs(VIEWER, () => getAssignments("project", P))).toHaveLength(1);
			expect(await actingAs(VIEWER, () => getAssignments("project_environment", ENV[P] ?? ""))).toHaveLength(1);
		});

		it("getAssignmentsForKind leaves P out for that member, and keeps it for the others", async () => {
			const denied = await actingAs(VIEW_DENIED, () => getAssignmentsForKind("project", [P, Q]));
			expect(Object.keys(denied)).toEqual([Q]);
			const viewer = await actingAs(VIEWER, () => getAssignmentsForKind("project", [P, Q]));
			expect(Object.keys(viewer).sort()).toEqual([P, Q].sort());
		});

		it("assignClassification refuses P and P's environment for the member denied editing P, and writes nothing", async () => {
			const input = (kind: "project" | "project_environment", id: string) => ({
				value_id: VALUE.added,
				resource_kind: kind,
				resource_id: id,
			});
			await expect(actingAs(EDIT_DENIED, () => assignClassification(input("project", P)))).rejects.toThrow(
				"Resource not found",
			);
			await expect(
				actingAs(EDIT_DENIED, () => assignClassification(input("project_environment", ENV[P] ?? ""))),
			).rejects.toThrow("Resource not found");
			expect(await assignedValues(P)).not.toContain(VALUE.added);
			expect(await assignedValues(ENV[P] ?? "")).not.toContain(VALUE.added);
			// The same member is served Q; a member without the deny is served P.
			await actingAs(EDIT_DENIED, () => assignClassification(input("project", Q)));
			expect(await assignedValues(Q)).toContain(VALUE.added);
			await actingAs(OPERATOR, () => assignClassification(input("project_environment", ENV[P] ?? "")));
			expect(await assignedValues(ENV[P] ?? "")).toContain(VALUE.added);
		});

		it("records the refused write: exactly one denied edit row naming P", async () => {
			const refusals = () => refusalsOnP(RECORD_EDIT, "edit");
			const before = await refusals();
			await expect(
				actingAs(RECORD_EDIT, () =>
					assignClassification({ value_id: VALUE.added, resource_kind: "project", resource_id: P }),
				),
			).rejects.toThrow("Resource not found");
			await settlesAt(refusals, before + 1);
		});

		it("unassignClassification refuses P for the member denied editing P, and leaves its chip", async () => {
			await expect(
				actingAs(EDIT_DENIED, () =>
					unassignClassification({ value_id: VALUE.seeded, resource_kind: "project", resource_id: P }),
				),
			).rejects.toThrow("Resource not found");
			expect(await assignedValues(P)).toContain(VALUE.seeded);
		});
	});

	describe("CLI classification on a project-owned resource", () => {
		it("GET answers P with no assignments for the member denied viewing P only", async () => {
			expect(await cliRead(VIEW_DENIED, "project", P)).toEqual({ status: 200, count: 0 });
			expect(await cliRead(VIEW_DENIED, "project_environment", ENV[P] ?? "")).toEqual({ status: 200, count: 0 });
			expect((await cliRead(VIEW_DENIED, "project", Q)).count).toBeGreaterThan(0);
			expect((await cliRead(VIEWER, "project", P)).count).toBeGreaterThan(0);
		});

		it("POST answers P as not found for the member denied editing P, and writes nothing", async () => {
			const env = ENV[P] ?? "";
			const before = await assignedValues(env);
			expect(await cliPin(EDIT_DENIED, "project_environment", env)).toBe(404);
			expect(await assignedValues(env)).toEqual(before);
			expect(await cliPin(EDIT_DENIED, "project_environment", ENV[Q] ?? "")).toBe(200);
		});

		it("DELETE answers P as not found for the member denied editing P, and clears nothing", async () => {
			expect(await cliClear(EDIT_DENIED, "project_environment", ENV[P] ?? "")).toBe(404);
			expect(await assignedValues(ENV[P] ?? "")).toContain(VALUE.seeded);
			expect(await cliClear(OPERATOR, "project_environment", ENV[Q] ?? "")).toBe(200);
			expect(await assignedValues(ENV[Q] ?? "")).not.toContain(VALUE.seeded);
		});
	});
	describe("console environment actions", () => {
		/** The environment names project `projectId` holds. */
		async function envNames(projectId: string): Promise<string[]> {
			const rows = await getServiceDb()
				.select({ name: projectEnvironments.name })
				.from(projectEnvironments)
				.where(eq(projectEnvironments.project_id, projectId));
			return rows.map((r) => r.name);
		}

		/** Whether environment `envId` has auto-heal on. */
		async function autoHeal(envId: string): Promise<boolean | undefined> {
			const [row] = await getServiceDb()
				.select({ on: projectEnvironments.auto_heal })
				.from(projectEnvironments)
				.where(eq(projectEnvironments.id, envId));
			return row?.on;
		}

		/** A fresh environment name, so a test never depends on what another test added. */
		const fresh = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;

		it("every write refuses a personal-workspace project from the team org's address as not found, and writes nothing", async () => {
			const before = await envNames(PERSONAL);
			await expect(
				actingAs(OPERATOR, () => addEnvironment(PERSONAL, { name: fresh("x"), stage: "development" })),
			).rejects.toThrow("Project not found.");
			await expect(
				actingAs(OPERATOR, () => duplicateEnvironment(PERSONAL, ENV[PERSONAL] ?? "", fresh("x"))),
			).rejects.toThrow("Project not found.");
			await expect(
				actingAs(OPERATOR, () => setAutoHeal(PERSONAL, ENV[PERSONAL] ?? "", true)),
			).rejects.toThrow("Project not found.");
			await expect(
				actingAs(OPERATOR, () => deleteEnvironment(PERSONAL, SPARE[PERSONAL] ?? "")),
			).rejects.toThrow("Project not found.");
			expect(await envNames(PERSONAL)).toEqual(before);
			expect(await autoHeal(ENV[PERSONAL] ?? "")).toBe(false);
		});

		it("every write refuses P for the member denied editing P, and writes nothing", async () => {
			const before = await envNames(P);
			await expect(
				actingAs(EDIT_DENIED, () => addEnvironment(P, { name: fresh("x"), stage: "development" })),
			).rejects.toThrow();
			await expect(actingAs(EDIT_DENIED, () => duplicateEnvironment(P, ENV[P] ?? "", fresh("x")))).rejects.toThrow();
			await expect(actingAs(EDIT_DENIED, () => setAutoHeal(P, ENV[P] ?? "", true))).rejects.toThrow();
			await expect(actingAs(EDIT_DENIED, () => deleteEnvironment(P, SPARE[P] ?? ""))).rejects.toThrow();
			expect(await envNames(P)).toEqual(before);
			expect(await autoHeal(ENV[P] ?? "")).toBe(false);
		});

		it("the same writes go through on Q for that member, and on P for a member without the deny", async () => {
			const q = fresh("q");
			expect(await actingAs(EDIT_DENIED, () => addEnvironment(Q, { name: q, stage: "development" }))).toMatchObject({
				ok: true,
			});
			expect(await envNames(Q)).toContain(q);
			await actingAs(OPERATOR, () => setAutoHeal(P, ENV[P] ?? "", true));
			expect(await autoHeal(ENV[P] ?? "")).toBe(true);
			await actingAs(OPERATOR, () => setAutoHeal(P, ENV[P] ?? "", false));
		});

		it("records a refused write once: exactly one denied edit row naming P", async () => {
			const refusals = () => refusalsOnP(RECORD_ENV_EDIT, "edit");
			const before = await refusals();
			await expect(actingAs(RECORD_ENV_EDIT, () => setAutoHeal(P, ENV[P] ?? "", true))).rejects.toThrow();
			await settlesAt(refusals, before + 1);
		});

		it("getProjectEnvironments refuses P for the member denied viewing P, and serves the others", async () => {
			await expect(actingAs(VIEW_DENIED, () => getProjectEnvironments(P))).rejects.toThrow();
			expect((await actingAs(VIEW_DENIED, () => getProjectEnvironments(Q))).environments.length).toBeGreaterThan(0);
			expect((await actingAs(VIEWER, () => getProjectEnvironments(P))).environments.length).toBeGreaterThan(0);
		});

		it("records a refused read once: exactly one denied view row naming P", async () => {
			const refusals = () => refusalsOnP(RECORD_ENV_VIEW, "view");
			const before = await refusals();
			await expect(actingAs(RECORD_ENV_VIEW, () => getProjectEnvironments(P))).rejects.toThrow();
			await settlesAt(refusals, before + 1);
		});
	});
});

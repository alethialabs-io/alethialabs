// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: row-level-security isolation — the multi-tenant blast wall. Seeded via the
// service connection (bypasses RLS); read/written back through the RLS-enforced app connection
// (withOwnerScope) to prove one org can never see OR mutate another's rows. Covers both the
// READ side (USING) and the WRITE side (WITH CHECK) across `projects` and `jobs` — the two
// owner-scoped tables the `owner_all` policy protects (lib/db/programmables.sql). Skips the
// isolation assertions when the app role isn't distinct from the service role (single-role dev).

import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { getProjectAddons } from "@/app/server/actions/addons";
import { getLatestDriftPosture } from "@/app/server/actions/drift";
import { runWithActor } from "@/lib/authz/actor-context";
import type { Actor } from "@/lib/authz/types";
import { getServiceDb, withOwnerScope } from "@/lib/db";
import {
	environmentDrift,
	grants,
	jobs,
	permission,
	projectAddons,
	projectEnvironments,
	projects,
} from "@/lib/db/schema";
import { describeIfDb } from "./db";

const ORG_A = randomUUID();
const ORG_B = randomUUID();

// The app role is only a real RLS boundary when it differs from the service role.
const APP_ROLE_DISTINCT =
	(process.env.ALETHIA_APP_DATABASE_URL ?? "") !== "" &&
	process.env.ALETHIA_APP_DATABASE_URL !== process.env.ALETHIA_DATABASE_URL;

describeIfDb("RLS tenant isolation", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		await db.insert(projects).values([
			{
				user_id: ORG_A,
				org_id: ORG_A,
				project_name: `a-${ORG_A.slice(0, 6)}`,
				region: "eu-west-1",
				iac_version: "1.0.0",
			},
			{
				user_id: ORG_B,
				org_id: ORG_B,
				project_name: `b-${ORG_B.slice(0, 6)}`,
				region: "eu-west-1",
				iac_version: "1.0.0",
			},
		]);
		// One job per org (the second owner-scoped table under the owner_all policy).
		await db.insert(jobs).values([
			{ user_id: ORG_A, org_id: ORG_A, job_type: "PLAN" },
			{ user_id: ORG_B, org_id: ORG_B, job_type: "PLAN" },
		]);
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(jobs).where(inArray(jobs.org_id, [ORG_A, ORG_B]));
		await db.delete(projects).where(inArray(projects.org_id, [ORG_A, ORG_B]));
	});

	it("the service connection sees both orgs' rows (RLS bypassed)", async () => {
		const rows = await getServiceDb()
			.select()
			.from(projects)
			.where(inArray(projects.org_id, [ORG_A, ORG_B]));
		expect(rows).toHaveLength(2);
	});

	// ── READ isolation (the USING clause) ──────────────────────────────────────
	it.skipIf(!APP_ROLE_DISTINCT)(
		"org A's app connection sees only org A's rows (projects + jobs)",
		async () => {
			const aProjects = await withOwnerScope(ORG_A, (tx) =>
				tx.select().from(projects).where(inArray(projects.org_id, [ORG_A, ORG_B])),
			);
			expect(aProjects.map((p) => p.org_id)).toEqual([ORG_A]);

			// Org A scope must NOT be able to read org B's row, even by asking for it.
			const leak = await withOwnerScope(ORG_A, (tx) =>
				tx.select().from(projects).where(eq(projects.org_id, ORG_B)),
			);
			expect(leak).toHaveLength(0);

			// Same wall on the jobs table.
			const aJobs = await withOwnerScope(ORG_A, (tx) =>
				tx.select().from(jobs).where(inArray(jobs.org_id, [ORG_A, ORG_B])),
			);
			expect(aJobs.map((j) => j.org_id)).toEqual([ORG_A]);
			const jobLeak = await withOwnerScope(ORG_A, (tx) =>
				tx.select().from(jobs).where(eq(jobs.org_id, ORG_B)),
			);
			expect(jobLeak).toHaveLength(0);
		},
	);

	// ── WRITE isolation (the WITH CHECK clause) ────────────────────────────────
	it.skipIf(!APP_ROLE_DISTINCT)(
		"org A cannot INSERT a row destined for org B (WITH CHECK denies)",
		async () => {
			// A project row whose tenancy (user_id/org_id) is org B, attempted from org A's
			// scope, violates WITH CHECK (user_id=current_owner OR org_id=current_org) → rejects.
			await expect(
				withOwnerScope(ORG_A, (tx) =>
					tx.insert(projects).values({
						user_id: ORG_B,
						org_id: ORG_B,
						project_name: `evil-${randomUUID().slice(0, 6)}`,
						region: "eu-west-1",
						iac_version: "1.0.0",
					}),
				),
			).rejects.toThrow();

			// And the same for jobs.
			await expect(
				withOwnerScope(ORG_A, (tx) =>
					tx.insert(jobs).values({ user_id: ORG_B, org_id: ORG_B, job_type: "PLAN" }),
				),
			).rejects.toThrow();

			// Nothing leaked in: org B still owns exactly its one seeded project.
			const bProjects = await getServiceDb()
				.select()
				.from(projects)
				.where(eq(projects.org_id, ORG_B));
			expect(bProjects).toHaveLength(1);
		},
	);

	it.skipIf(!APP_ROLE_DISTINCT)(
		"org A cannot UPDATE or DELETE org B's rows (USING hides them → 0 affected)",
		async () => {
			// UPDATE of org B's project from org A's scope matches no rows (RLS-invisible).
			const updated = await withOwnerScope(ORG_A, (tx) =>
				tx
					.update(projects)
					.set({ project_name: "hijacked" })
					.where(eq(projects.org_id, ORG_B))
					.returning({ id: projects.id }),
			);
			expect(updated).toHaveLength(0);

			// DELETE likewise affects nothing.
			const deleted = await withOwnerScope(ORG_A, (tx) =>
				tx.delete(jobs).where(eq(jobs.org_id, ORG_B)).returning({ id: jobs.id }),
			);
			expect(deleted).toHaveLength(0);

			// Verify via the service connection: org B's rows are untouched and intact.
			const bProject = await getServiceDb()
				.select()
				.from(projects)
				.where(eq(projects.org_id, ORG_B));
			expect(bProject).toHaveLength(1);
			expect(bProject[0].project_name).not.toBe("hijacked");
			const bJob = await getServiceDb()
				.select()
				.from(jobs)
				.where(eq(jobs.org_id, ORG_B));
			expect(bJob).toHaveLength(1);
		},
	);

	// Non-vacuity control: within its OWN scope, org A can read + update its rows — the wall
	// blocks cross-tenant access, not all access (else the deny assertions would be trivial).
	it.skipIf(!APP_ROLE_DISTINCT)(
		"org A CAN read and update its own rows (the wall is not blocking everything)",
		async () => {
			const own = await withOwnerScope(ORG_A, (tx) =>
				tx
					.update(projects)
					.set({ iac_version: "1.0.1" })
					.where(and(eq(projects.org_id, ORG_A), eq(projects.user_id, ORG_A)))
					.returning({ id: projects.id }),
			);
			expect(own).toHaveLength(1);
		},
	);
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-tenant read of RLS-less project-child tables (drift + addons). Unlike
// `projects`/`jobs` above, `environment_drift` and `project_addons` carry NO
// per-tenant RLS policy — the belt-and-suspenders backstop is deferred to a later
// wave — so the ONLY thing stopping one org from reading another's rows is each
// server action's own org predicate. The PDP is org-blind on resource ownership: an
// org-wide `project:view` grant makes authorize("view", { project, id: ANY_UUID })
// succeed for ANY project UUID, so without the org join these reads leak another
// org's drift detail (recon-grade resource addresses) and addon/GitOps config.
//
// These cases inject an ORG_A actor (the MCP token path — runWithActor), call the
// action for ORG_B's project, and assert nothing comes back. The same-org and
// Teams-shaped cases prove the org filter doesn't over-restrict (a naive RLS-only
// fix under withOwnerScope(actor.userId) would wrongly hide a teammate's project;
// the explicit actor.orgId filter returns it). The leak is gated solely by the
// app-layer org join here (APP_ROLE_DISTINCT is irrelevant — these tables have no
// RLS), which is exactly the fix under test.
describeIfDb("Cross-tenant read of project-child tables (drift + addons)", () => {
	const DRIFT_ORG_A = randomUUID();
	const DRIFT_ORG_B = randomUUID();
	const DRIFT_ORG_TEAM = randomUUID();
	const TEAM_OWNER = randomUUID(); // owns the Teams project …
	const TEAM_READER = randomUUID(); // … a *different* teammate reads it via an org grant

	let projectAId = "";
	let projectBId = "";
	let projectTId = "";
	let envAId = "";
	let envBId = "";
	let envTId = "";

	/** Seeds an org-wide (resource_id NULL) `project:view` ALLOW grant for a user principal. */
	async function seedOrgWideViewGrant(
		orgId: string,
		userId: string,
	): Promise<void> {
		await getServiceDb().insert(grants).values({
			org_id: orgId,
			principal_type: "user",
			principal_id: userId,
			effect: "allow",
			permission_key: "project:view",
			resource_type: "project",
			resource_id: null,
		});
	}

	beforeAll(async () => {
		const db = getServiceDb();
		// The permission the grants reference (FK target). migrate.mjs doesn't run the
		// PDP registry seed, so insert the one key these grants need.
		await db
			.insert(permission)
			.values({
				key: "project:view",
				resource: "project",
				action: "view",
				description: "View a project",
			})
			.onConflictDoNothing();

		// A + B are community projects (org_id === user_id); T is Teams-shaped — owned by
		// TEAM_OWNER but scoped to DRIFT_ORG_TEAM and read by a different teammate.
		const [pa, pb, pt] = await db
			.insert(projects)
			.values([
				{
					user_id: DRIFT_ORG_A,
					org_id: DRIFT_ORG_A,
					project_name: `drift-a-${DRIFT_ORG_A.slice(0, 6)}`,
					region: "eu-west-1",
					iac_version: "1.0.0",
				},
				{
					user_id: DRIFT_ORG_B,
					org_id: DRIFT_ORG_B,
					project_name: `drift-b-${DRIFT_ORG_B.slice(0, 6)}`,
					region: "eu-west-1",
					iac_version: "1.0.0",
				},
				{
					user_id: TEAM_OWNER,
					org_id: DRIFT_ORG_TEAM,
					project_name: `drift-t-${DRIFT_ORG_TEAM.slice(0, 6)}`,
					region: "eu-west-1",
					iac_version: "1.0.0",
				},
			])
			.returning({ id: projects.id });
		projectAId = pa.id;
		projectBId = pb.id;
		projectTId = pt.id;

		// One default environment per project (getProjectAddons resolves the default env).
		const [ea, eb, et] = await db
			.insert(projectEnvironments)
			.values([
				{
					project_id: projectAId,
					user_id: DRIFT_ORG_A,
					org_id: DRIFT_ORG_A,
					name: "prod",
					is_default: true,
				},
				{
					project_id: projectBId,
					user_id: DRIFT_ORG_B,
					org_id: DRIFT_ORG_B,
					name: "prod",
					is_default: true,
				},
				{
					project_id: projectTId,
					user_id: TEAM_OWNER,
					org_id: DRIFT_ORG_TEAM,
					name: "prod",
					is_default: true,
				},
			])
			.returning({ id: projectEnvironments.id });
		envAId = ea.id;
		envBId = eb.id;
		envTId = et.id;

		// Distinctive drift rows — B's addresses are what would leak if the read is unscoped.
		await db.insert(environmentDrift).values([
			{
				project_id: projectAId,
				environment_id: envAId,
				in_sync: false,
				drifted: 1,
				details: [
					{
						address: "module.a.aws_s3_bucket.own",
						type: "aws_s3_bucket",
						kind: "modified",
					},
				],
				scanned_at: new Date(),
			},
			{
				project_id: projectBId,
				environment_id: envBId,
				in_sync: false,
				drifted: 1,
				details: [
					{
						address: "module.secret.aws_db_instance.x",
						type: "aws_db_instance",
						kind: "modified",
					},
				],
				scanned_at: new Date(),
			},
			{
				project_id: projectTId,
				environment_id: envTId,
				in_sync: false,
				drifted: 1,
				details: [
					{
						address: "module.team.aws_eks_cluster.k",
						type: "aws_eks_cluster",
						kind: "modified",
					},
				],
				scanned_at: new Date(),
			},
		]);

		// Distinctive addon installs (catalog ids from lib/addons/catalog.ts).
		await db.insert(projectAddons).values([
			{
				project_id: projectAId,
				environment_id: envAId,
				addon_id: "cert-manager",
				enabled: true,
				mode: "managed",
				namespace: "cert-manager",
				status: "PENDING",
			},
			{
				project_id: projectBId,
				environment_id: envBId,
				addon_id: "vault",
				enabled: true,
				mode: "managed",
				namespace: "vault",
				status: "PENDING",
			},
		]);

		// The org-blind grants that make authorize("view", project:ANY) succeed.
		await seedOrgWideViewGrant(DRIFT_ORG_A, DRIFT_ORG_A);
		await seedOrgWideViewGrant(DRIFT_ORG_TEAM, TEAM_READER);
	});

	afterAll(async () => {
		const db = getServiceDb();
		const projectIds = [projectAId, projectBId, projectTId];
		await db
			.delete(environmentDrift)
			.where(inArray(environmentDrift.project_id, projectIds));
		await db
			.delete(projectAddons)
			.where(inArray(projectAddons.project_id, projectIds));
		await db
			.delete(projectEnvironments)
			.where(inArray(projectEnvironments.project_id, projectIds));
		await db.delete(projects).where(inArray(projects.id, projectIds));
		await db
			.delete(grants)
			.where(inArray(grants.org_id, [DRIFT_ORG_A, DRIFT_ORG_TEAM]));
		await db.delete(permission).where(eq(permission.key, "project:view"));
	});

	/** Runs `fn` under an injected Actor (the MCP token path binds it via runWithActor). */
	function asActor<T>(
		userId: string,
		orgId: string,
		fn: () => Promise<T>,
	): Promise<T> {
		const actor: Actor = { userId, orgId };
		return runWithActor(actor, fn);
	}

	// ── drift.getLatestDriftPosture ─────────────────────────────────────────────
	it("does NOT leak another org's drift posture (ORG_A reads ORG_B's project)", async () => {
		const leaked = await asActor(DRIFT_ORG_A, DRIFT_ORG_A, () =>
			getLatestDriftPosture(projectBId),
		);
		expect(leaked).toBeNull();
	});

	it("returns the caller's OWN drift posture (the wall isn't blocking everything)", async () => {
		const own = await asActor(DRIFT_ORG_A, DRIFT_ORG_A, () =>
			getLatestDriftPosture(projectAId),
		);
		expect(own).not.toBeNull();
		expect(own?.details.map((d) => d.address)).toEqual([
			"module.a.aws_s3_bucket.own",
		]);
	});

	it("returns a teammate's project drift under a Teams org (org-, not user-scoped)", async () => {
		const teamRead = await asActor(TEAM_READER, DRIFT_ORG_TEAM, () =>
			getLatestDriftPosture(projectTId),
		);
		expect(teamRead).not.toBeNull();
		expect(teamRead?.details.map((d) => d.address)).toEqual([
			"module.team.aws_eks_cluster.k",
		]);
	});

	// ── addons.getProjectAddons ─────────────────────────────────────────────────
	it("does NOT leak another org's addon install state (ORG_A reads ORG_B's project)", async () => {
		// getProjectAddons resolves the project's active environment first, and that resolution is
		// now ORG-SCOPED (resolve.ts) — ORG_A cannot resolve ORG_B's environment, so the read
		// fails closed (throws) rather than returning ORG_B's install state. Either way, no leak.
		await expect(
			asActor(DRIFT_ORG_A, DRIFT_ORG_A, () => getProjectAddons(projectBId)),
		).rejects.toThrow();
	});

	it("returns the caller's OWN addon install state (non-vacuity)", async () => {
		const view = await asActor(DRIFT_ORG_A, DRIFT_ORG_A, () =>
			getProjectAddons(projectAId),
		);
		const installed = view.items
			.filter((i) => i.install !== null)
			.map((i) => i.id);
		expect(installed).toEqual(["cert-manager"]);
	});

	it("returns a teammate's project addons under a Teams org (org-scoped env resolution)", async () => {
		// Availability half: a Teams teammate (not the project owner) must be able to read the
		// project's addons. The old personal-scoped resolveActiveEnvironmentId threw "no default
		// environment" for them; org-scoped resolution finds the org's env, so the read succeeds.
		const view = await asActor(TEAM_READER, DRIFT_ORG_TEAM, () =>
			getProjectAddons(projectTId),
		);
		expect(view.environmentId).toBeTruthy();
		expect(Array.isArray(view.items)).toBe(true);
	});
});

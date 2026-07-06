// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Integration: the community PostgresRbacPDP against real Postgres. Mocks can't verify the
// grant-resolution SQL, the recursive resource_hierarchy walk, the explicit-deny-wins
// semantics, role→permission resolution, or team-membership resolution — so seed real
// grants/roles/teams/hierarchy via the service connection (bypasses RLS) and assert the
// exact allow/deny decisions + listAccessible filtering. Unique ids per run; cleaned up.

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { PostgresRbacPDP } from "@/lib/authz/postgres-rbac-pdp";
import { BUILTIN_ROLE_IDS } from "@/lib/authz/registry";
import { seedAuthz } from "@/lib/authz/seed";
import type { Actor } from "@/lib/authz/types";
import { ForbiddenError } from "@/lib/authz/types";
import { getServiceDb } from "@/lib/db";
import {
	authzActivityLog,
	grants,
	organization,
	projects,
	resourceHierarchy,
	team,
	teamMember,
	user,
} from "@/lib/db/schema";
import { describeIfDb } from "./db";

// Stable per-run fixture ids (unique → never collide with other rows / parallel runs).
const ORG = randomUUID();
const USER = randomUUID(); // the actor
const OUTSIDER = randomUUID(); // a user in the org with no grants / not on the team
const TEAM = randomUUID();
const PROJ_A = randomUUID(); // child of ORG in the hierarchy
const PROJ_B = randomUUID(); // NOT under ORG in the hierarchy (a sibling, no edge)

const pdp = new PostgresRbacPDP();
const actor: Actor = { userId: USER, orgId: ORG };

/** Insert one grant row for the test-org, returning nothing (cleaned up in afterEach). */
async function seedGrant(values: {
	principal_type: "user" | "team";
	principal_id: string;
	effect?: "allow" | "deny";
	role_id?: string;
	permission_key?: string;
	resource_type: string;
	resource_id?: string | null;
}): Promise<void> {
	await getServiceDb()
		.insert(grants)
		.values({
			org_id: ORG,
			effect: "allow",
			resource_id: null,
			...values,
		});
}

describeIfDb("PostgresRbacPDP (community RBAC over Postgres)", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		// Seed the GLOBAL authz catalog (permission/role/role_permission) from the registry so the
		// grants below satisfy their permission_key/role_id foreign keys. This test seeds its own
		// catalog rather than relying on authz-seed.test.ts running first — vitest's file order is
		// not alphabetical, so depending on cross-file ordering makes this suite flaky. seedAuthz()
		// is idempotent (onConflictDoNothing) and its module-level run-once guard is per test file.
		await seedAuthz();
		// Actor + outsider users, the org, a team the actor belongs to (for team grants).
		await db.insert(user).values([
			{ id: USER, email: `it-pdp-actor-${USER}@example.test` },
			{ id: OUTSIDER, email: `it-pdp-outsider-${OUTSIDER}@example.test` },
		]);
		await db.insert(organization).values({ id: ORG, name: `pdp-${ORG.slice(0, 8)}` });
		await db.insert(team).values({ id: TEAM, name: "platform", organizationId: ORG });
		await db.insert(teamMember).values({ teamId: TEAM, userId: USER });
		// Two projects in the org. PROJ_A is a hierarchy child of ORG; PROJ_B has no edge.
		await db.insert(projects).values([
			{
				id: PROJ_A,
				user_id: ORG,
				org_id: ORG,
				project_name: `a-${PROJ_A.slice(0, 6)}`,
				region: "eu-west-1",
				iac_version: "1.0.0",
			},
			{
				id: PROJ_B,
				user_id: ORG,
				org_id: ORG,
				project_name: `b-${PROJ_B.slice(0, 6)}`,
				region: "eu-west-1",
				iac_version: "1.0.0",
			},
		]);
		// Org→Project edge so an org-scoped grant flows down to PROJ_A (but not PROJ_B).
		await db.insert(resourceHierarchy).values({
			child_type: "project",
			child_id: PROJ_A,
			parent_type: "org",
			parent_id: ORG,
		});
	});

	afterEach(async () => {
		// Each test seeds its own grants; reset between tests so cases don't bleed.
		await getServiceDb().delete(grants).where(eq(grants.org_id, ORG));
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(grants).where(eq(grants.org_id, ORG));
		await db.delete(authzActivityLog).where(eq(authzActivityLog.org_id, ORG));
		await db
			.delete(resourceHierarchy)
			.where(inArray(resourceHierarchy.parent_id, [ORG]));
		await db.delete(teamMember).where(eq(teamMember.teamId, TEAM));
		await db.delete(team).where(eq(team.id, TEAM));
		await db.delete(projects).where(eq(projects.org_id, ORG));
		await db.delete(organization).where(eq(organization.id, ORG));
		await db.delete(user).where(inArray(user.id, [USER, OUTSIDER]));
	});

	it("default-denies (no_grant) when the actor has no grants", async () => {
		const d = await pdp.can(actor, "view", { type: "project", id: PROJ_A });
		expect(d.allowed).toBe(false);
		expect(d.reason).toBe("no_grant");
	});

	it("org-wide single-permission allow covers every resource of the type", async () => {
		await seedGrant({
			principal_type: "user",
			principal_id: USER,
			permission_key: "project:view",
			resource_type: "project",
			resource_id: null, // org-wide wildcard
		});
		expect((await pdp.can(actor, "view", { type: "project", id: PROJ_A })).allowed).toBe(true);
		expect((await pdp.can(actor, "view", { type: "project", id: PROJ_B })).allowed).toBe(true);

		// The grant is project:view only — a different action is still default-denied.
		const deploy = await pdp.can(actor, "deploy", { type: "project", id: PROJ_A });
		expect(deploy.allowed).toBe(false);
		expect(deploy.reason).toBe("no_grant");
	});

	it("a scoped allow covers only the named resource (out_of_scope otherwise)", async () => {
		await seedGrant({
			principal_type: "user",
			principal_id: USER,
			permission_key: "project:view",
			resource_type: "project",
			resource_id: PROJ_A,
		});
		expect((await pdp.can(actor, "view", { type: "project", id: PROJ_A })).allowed).toBe(true);

		const other = await pdp.can(actor, "view", { type: "project", id: PROJ_B });
		expect(other.allowed).toBe(false);
		expect(other.reason).toBe("out_of_scope");
	});

	it("a grant on an ancestor flows DOWN the resource hierarchy", async () => {
		// Scoped to the ORG; PROJ_A is a hierarchy child of ORG, PROJ_B is not.
		await seedGrant({
			principal_type: "user",
			principal_id: USER,
			permission_key: "project:view",
			resource_type: "project",
			resource_id: ORG,
		});
		expect((await pdp.can(actor, "view", { type: "project", id: PROJ_A })).allowed).toBe(true);

		const noEdge = await pdp.can(actor, "view", { type: "project", id: PROJ_B });
		expect(noEdge.allowed).toBe(false);
		expect(noEdge.reason).toBe("out_of_scope");
	});

	it("explicit deny overrides an org-wide allow (IAM semantics)", async () => {
		await seedGrant({
			principal_type: "user",
			principal_id: USER,
			effect: "allow",
			permission_key: "project:view",
			resource_type: "project",
			resource_id: null, // allow everything
		});
		await seedGrant({
			principal_type: "user",
			principal_id: USER,
			effect: "deny",
			permission_key: "project:view",
			resource_type: "project",
			resource_id: PROJ_A, // …except PROJ_A
		});

		const denied = await pdp.can(actor, "view", { type: "project", id: PROJ_A });
		expect(denied.allowed).toBe(false);
		expect(denied.reason).toBe("explicit_deny");

		// PROJ_A's deny must NOT bleed onto PROJ_B — still allowed via the org-wide grant.
		expect((await pdp.can(actor, "view", { type: "project", id: PROJ_B })).allowed).toBe(true);
	});

	it("resolves permissions through a role (role_permission join)", async () => {
		// Built-in viewer role: has project:view, NOT project:deploy.
		await seedGrant({
			principal_type: "user",
			principal_id: USER,
			role_id: BUILTIN_ROLE_IDS.viewer,
			resource_type: "project",
			resource_id: null,
		});
		expect((await pdp.can(actor, "view", { type: "project", id: PROJ_A })).allowed).toBe(true);

		const deploy = await pdp.can(actor, "deploy", { type: "project", id: PROJ_A });
		expect(deploy.allowed).toBe(false);
		expect(deploy.reason).toBe("no_grant"); // viewer never carries project:deploy
	});

	it("honors a grant to a team the actor belongs to (and only members)", async () => {
		await seedGrant({
			principal_type: "team",
			principal_id: TEAM,
			permission_key: "project:view",
			resource_type: "project",
			resource_id: null,
		});
		// USER is on TEAM → allowed.
		expect((await pdp.can(actor, "view", { type: "project", id: PROJ_A })).allowed).toBe(true);

		// OUTSIDER is in the same org but NOT on the team → the team grant doesn't apply.
		const outsider = await pdp.can(
			{ userId: OUTSIDER, orgId: ORG },
			"view",
			{ type: "project", id: PROJ_A },
		);
		expect(outsider.allowed).toBe(false);
		expect(outsider.reason).toBe("no_grant");
	});

	it("scopes by org_id — a grant in another org does not apply", async () => {
		await seedGrant({
			principal_type: "user",
			principal_id: USER,
			permission_key: "project:view",
			resource_type: "project",
			resource_id: null,
		});
		// Same user, different active org → the grant (org_id = ORG) must not match.
		const elsewhere = await pdp.can(
			{ userId: USER, orgId: randomUUID() },
			"view",
			{ type: "project", id: PROJ_A },
		);
		expect(elsewhere.allowed).toBe(false);
		expect(elsewhere.reason).toBe("no_grant");
	});

	it("listAccessible: org-wide allow returns every project in the org", async () => {
		await seedGrant({
			principal_type: "user",
			principal_id: USER,
			permission_key: "project:view",
			resource_type: "project",
			resource_id: null,
		});
		const ids = await pdp.listAccessible(actor, "view", "project");
		expect(new Set(ids)).toEqual(new Set([PROJ_A, PROJ_B]));
	});

	// These two scoped-grant paths exercise descendantsOfType, which had a real uuid[]
	// binding bug (only real Postgres caught it): `${scoped}::uuid[]` cast a single
	// drizzle-spread scalar → "malformed array literal", breaking EVERY scoped listAccessible.
	// Fixed by binding a proper `array[$1,$2,…]::uuid[]` literal; these now assert the
	// intended descend/deny-subtraction results.

	it("listAccessible: a scoped allow descends to PROJ_A (edge) but not PROJ_B (no edge)", async () => {
		await seedGrant({
			principal_type: "user",
			principal_id: USER,
			permission_key: "project:view",
			resource_type: "project",
			resource_id: ORG,
		});
		const ids = await pdp.listAccessible(actor, "view", "project");
		expect(ids).toEqual([PROJ_A]);
	});

	it("listAccessible: an org-wide allow minus a deny on PROJ_A leaves PROJ_B", async () => {
		await seedGrant({
			principal_type: "user",
			principal_id: USER,
			effect: "allow",
			permission_key: "project:view",
			resource_type: "project",
			resource_id: null,
		});
		await seedGrant({
			principal_type: "user",
			principal_id: USER,
			effect: "deny",
			permission_key: "project:view",
			resource_type: "project",
			resource_id: PROJ_A,
		});
		const ids = await pdp.listAccessible(actor, "view", "project");
		expect(ids).toEqual([PROJ_B]); // org-wide allow (A,B) minus deny on A
	});

	it("listAccessible: an org-wide deny removes everything", async () => {
		await seedGrant({
			principal_type: "user",
			principal_id: USER,
			effect: "allow",
			permission_key: "project:view",
			resource_type: "project",
			resource_id: null,
		});
		await seedGrant({
			principal_type: "user",
			principal_id: USER,
			effect: "deny",
			permission_key: "project:view",
			resource_type: "project",
			resource_id: null,
		});
		expect(await pdp.listAccessible(actor, "view", "project")).toEqual([]);
	});

	it("enforce() resolves on allow and throws ForbiddenError on deny", async () => {
		await seedGrant({
			principal_type: "user",
			principal_id: USER,
			permission_key: "project:view",
			resource_type: "project",
			resource_id: PROJ_A,
		});
		await expect(
			pdp.enforce(actor, "view", { type: "project", id: PROJ_A }),
		).resolves.toBeUndefined();
		await expect(
			pdp.enforce(actor, "view", { type: "project", id: PROJ_B }),
		).rejects.toBeInstanceOf(ForbiddenError);
	});
});

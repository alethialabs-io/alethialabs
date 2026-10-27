// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// THE ENVIRONMENTS PAGE'S READS FOLLOW PROJECT VISIBILITY (#6120), against real Postgres, RLS and the
// edition's PDP.
//
// The tenancy suite (rpc-tenancy.shared.ts) proves these reads are bound to the ADDRESSED org. This
// file proves the other half: INSIDE the org, a member with an explicit deny on viewing project P
// reads none of P's environments page — the overview, an environment's protection rules, a promote
// preview — while a viewer without the deny reads all three. Every grant and hierarchy edge is
// written the way the app writes it: the Postgres row, then its tuple mirror (as jobs-visibility).

import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runWithActor } from "@/lib/authz/actor-context";
import { ensureMemberGrant } from "@/lib/authz/grants";
import { seedAuthz } from "@/lib/authz/seed";
import { getTupleSync } from "@/lib/authz/tuple-sync";
import { ForbiddenError } from "@/lib/authz/types";
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
import {
	readEnvironmentsOverview,
	readPromotionPreview,
	readProtectionRules,
} from "@/lib/rpc/procedures/environments";
import { describeIfDb, purgeAuthzActivityLog } from "./db";

const ORG = randomUUID();
const ADMIN = randomUUID(); // authors every row; never reads
const VIEWER = randomUUID(); // may view every project
const DENIED = randomUUID(); // explicitly denied viewing project P
const USERS = [ADMIN, VIEWER, DENIED];
const P = randomUUID();
const SLUG = `it-6120-${P.slice(0, 8)}`;
let envP = "";

/** Runs a read as `userId` in the org, as the read router binds it. */
function readAs<T>(userId: string, read: () => Promise<T>): Promise<T> {
	return runWithActor({ userId, orgId: ORG, credential: "session" }, read);
}

/** The three reads of P's environments page, each as `userId`. */
function pageReads(userId: string): [string, () => Promise<unknown>][] {
	return [
		["overview", () => readAs(userId, () => readEnvironmentsOverview(SLUG))],
		["protectionRules", () => readAs(userId, () => readProtectionRules(P, envP))],
		["promotionPreview", () => readAs(userId, () => readPromotionPreview(P, envP, envP, false))],
	];
}

describeIfDb("the Environments page's reads follow project visibility (#6120)", () => {
	beforeAll(async () => {
		const state = editionState();
		const expected = process.env.ALETHIA_EDITION === "enterprise" ? "enterprise" : "community";
		if (state.kind !== expected) {
			throw new Error(`the ${expected} edition did not load (${JSON.stringify(state)}); this suite would measure another engine`);
		}

		const db = getServiceDb();
		await seedAuthz();
		await db.insert(user).values(USERS.map((id) => ({ id, email: `it-6120-${id}@example.test` })));
		await db.insert(organization).values({ id: ORG, name: `it-6120-${ORG.slice(0, 8)}`, slug: `it-6120-${ORG.slice(0, 8)}` });
		await db.insert(member).values([
			{ organizationId: ORG, userId: ADMIN, role: "admin" },
			{ organizationId: ORG, userId: VIEWER, role: "viewer" },
			{ organizationId: ORG, userId: DENIED, role: "viewer" },
		]);
		await ensureMemberGrant(ORG, ADMIN, "admin");
		await ensureMemberGrant(ORG, VIEWER, "viewer");
		await ensureMemberGrant(ORG, DENIED, "viewer");
		await db.insert(projects).values({
			id: P,
			user_id: ADMIN,
			org_id: ORG,
			project_name: SLUG,
			slug: SLUG,
			region: "eu-west-1",
			iac_version: "1.0.0",
		});
		const [e] = await db
			.insert(projectEnvironments)
			.values({ project_id: P, user_id: ADMIN, org_id: ORG, name: "dev", status: "DRAFT", is_default: true })
			.returning({ id: projectEnvironments.id });
		envP = e.id;
		// The org → project edge creating a project writes, mirrored to the enterprise PDP's store.
		await db.insert(resourceHierarchy).values({ child_type: "project", child_id: P, parent_type: "org", parent_id: ORG });
		await getTupleSync().syncHierarchyEdge({ childType: "project", childId: P, parentType: "org", parentId: ORG });
		// The explicit deny, written as the grants action writes one — the row, then its mirror.
		await db.insert(grants).values({
			org_id: ORG,
			principal_type: "user",
			principal_id: DENIED,
			effect: "deny",
			permission_key: "project:view",
			resource_type: "project",
			resource_id: P,
		});
		await getTupleSync().syncScopedGrant({
			orgId: ORG,
			principalType: "user",
			principalId: DENIED,
			effect: "deny",
			resourceType: "project",
			resourceId: P,
			roleId: null,
			permissionKey: "project:view",
		});
	});

	afterAll(async () => {
		const db = getServiceDb();
		await db.delete(resourceHierarchy).where(eq(resourceHierarchy.parent_id, ORG));
		await db.delete(projects).where(eq(projects.org_id, ORG)); // cascades the environment
		await purgeAuthzActivityLog(inArray(authzActivityLog.org_id, [ORG]));
		await db.delete(grants).where(eq(grants.org_id, ORG));
		await db.delete(member).where(eq(member.organizationId, ORG));
		await db.delete(organization).where(eq(organization.id, ORG));
		await db.delete(user).where(inArray(user.id, USERS));
	});

	describe("a member with an explicit deny on viewing P", () => {
		it.each(pageReads(DENIED).map(([name]) => name))("is refused P's %s", async (name) => {
			const read = new Map(pageReads(DENIED)).get(name);
			if (!read) throw new Error(`no read named ${name}`);
			await expect(read()).rejects.toBeInstanceOf(ForbiddenError);
		});
	});

	describe("the control: a viewer without the deny", () => {
		it("reads P's overview, naming P and its environment", async () => {
			const out = await readAs(VIEWER, () => readEnvironmentsOverview(SLUG));
			expect(out.projectId).toBe(P);
			expect(out.envs.map((e) => e.id)).toEqual([envP]);
		});

		it("reads P's protection rules and a promote preview", async () => {
			expect(await readAs(VIEWER, () => readProtectionRules(P, envP))).toEqual({
				environmentId: envP,
				rules: null,
			});
			expect(await readAs(VIEWER, () => readPromotionPreview(P, envP, envP, false))).toMatchObject({
				sourceId: envP,
				targetId: envP,
			});
		});
	});
});

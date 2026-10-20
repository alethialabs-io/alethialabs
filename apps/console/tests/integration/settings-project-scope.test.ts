// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6128 review blocker, against real Postgres + RLS (enterprise edition): a project-by-slug
// settings read answers the ADDRESSED org's project, never the caller's same-slug PERSONAL one.
//
// Why RLS alone is not enough: the projects policy admits `org_id = current_org OR org_id =
// current_owner`, so on a page inside org Z the caller's personal projects are visible too. With a
// lookup on the slug alone and `LIMIT 1`, a personal project under the same slug could be the row
// the General / Preview pages resolved — and their Rename and Delete would then act on it.
//
// The cases are DETERMINISTIC on purpose: with no Z project under the slug, the only visible row is
// the personal one, so a lookup that drops the org condition returns it every time (not by chance).

import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

/** The hoisted request state the mocks read; `previous` restores the edition after the file. */
interface HoistedRequest {
	path: string;
	user: string;
	previous: string | undefined;
}

const h = vi.hoisted((): HoistedRequest => {
	const previous = process.env.ALETHIA_EDITION;
	// Before ANY import: `lib/auth` builds better-auth at module evaluation, which loads the edition.
	process.env.ALETHIA_EDITION = "enterprise";
	return { path: "", user: "", previous };
});

vi.mock("next/headers", () => ({
	headers: async () => new Headers({ "x-alethia-path": h.path }),
}));
vi.mock("@/lib/auth/owner", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/auth/owner")>()),
	getOwnerScope: async () => ({ userId: h.user, sessionId: "s", activeOrgId: undefined }),
}));
vi.mock("@/lib/billing/eligibility", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/billing/eligibility")>()),
	hasAcceptedCurrentDocuments: async () => true,
}));

import { ensureMemberGrant } from "@/lib/authz/grants";
import { seedAuthz } from "@/lib/authz/seed";
import { getServiceDb } from "@/lib/db";
import { authzActivityLog, grants, member, organization, projects, user } from "@/lib/db/schema";
import { serverOrpc } from "@/lib/rpc/server";
import { describeIfDb, purgeAuthzActivityLog } from "./db";

const ORG = randomUUID();
const SLUG = `it-6128-${ORG.slice(0, 8)}`;
const U = randomUUID(); // the caller: a member of ORG, with personal projects of their own
const ONLY_PERSONAL = "it-6128-only-personal";
const BOTH = "it-6128-both";
const created: string[] = [];

/** A project under `slug` in `orgId`, created by U. */
async function seedProject(orgId: string, slug: string): Promise<string> {
	const [row] = await getServiceDb()
		.insert(projects)
		.values({
			user_id: U,
			org_id: orgId,
			project_name: `${slug}-${orgId.slice(0, 8)}`,
			slug,
			region: "eu-west-1",
			iac_version: "1.0.0",
		})
		.returning({ id: projects.id });
	created.push(row.id);
	return row.id;
}

/** Calls a settings read as U, with the address on ORG. */
function asCallerInOrg() {
	h.path = `/${SLUG}/~/settings/general`;
	h.user = U;
	return serverOrpc().settings;
}

let orgProject = "";

describeIfDb("#6128 settings reads resolve a project slug inside the ADDRESSED org", () => {
	beforeAll(async () => {
		const db = getServiceDb();
		await seedAuthz();
		await db.insert(user).values({ id: U, email: `it-6128-${U}@example.test` });
		await db.insert(organization).values({ id: ORG, name: SLUG, slug: SLUG });
		await db.insert(member).values({ organizationId: ORG, userId: U, role: "admin" });
		await ensureMemberGrant(U, U, "owner");
		await ensureMemberGrant(ORG, U, "admin");
		// A slug only the caller's PERSONAL scope holds…
		await seedProject(U, ONLY_PERSONAL);
		// …and a slug both scopes hold.
		await seedProject(U, BOTH);
		orgProject = await seedProject(ORG, BOTH);
	});

	afterAll(async () => {
		const db = getServiceDb();
		if (created.length) await db.delete(projects).where(inArray(projects.id, created));
		await purgeAuthzActivityLog(inArray(authzActivityLog.org_id, [ORG, U]));
		await db.delete(grants).where(inArray(grants.org_id, [ORG, U]));
		await db.delete(member).where(inArray(member.organizationId, [ORG]));
		await db.delete(organization).where(inArray(organization.id, [ORG]));
		await db.delete(user).where(inArray(user.id, [U]));
		if (h.previous === undefined) delete process.env.ALETHIA_EDITION;
		else process.env.ALETHIA_EDITION = h.previous;
	});

	it("a slug only the caller's personal scope holds is NOT a project of this org (General and Preview)", async () => {
		const settings = asCallerInOrg();
		expect(await settings.project.call({ project: ONLY_PERSONAL })).toBeNull();
		expect(await settings.preview.call({ project: ONLY_PERSONAL })).toBeNull();
	});

	it("a slug both scopes hold resolves to the org's project, every time", async () => {
		for (let i = 0; i < 5; i++) {
			const settings = asCallerInOrg();
			expect(await settings.project.call({ project: BOTH })).toMatchObject({ id: orgProject });
			expect(await settings.preview.call({ project: BOTH })).toMatchObject({ projectId: orgProject });
		}
	});
});

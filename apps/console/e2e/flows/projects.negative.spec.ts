// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// E2E — Projects domain: validation errors, the member denial, delete guards, duplicate-name
// behavior, not-found and auth checks. Happy paths live in projects.spec.ts, whose header explains
// what `/{org}/~/new` became — in short, every create in this file goes through the **Configure**
// step (`~/new?scratch=blank`), because the single-form "Create empty project" button these tests
// used to click no longer exists.
//
// Run (self-check):
//   REUSE_AUTH=1 E2E_BASE_URL=http://localhost:3100 DEV_CONSOLE_LOG=/tmp/alethia-qa-console.log \
//     E2E_WORKERS=1 E2E_RETRIES=0 npx playwright test e2e/flows/projects.negative.spec.ts \
//     --output=test-results/wf-projects-neg
//
// Isolation: uniquely-named seeds scoped to the persona org; no cleanupOrg (shared org during the
// parallel QA run).

import { randomUUID } from "node:crypto";

import { test, expect } from "../fixtures/qa";
import { db } from "../helpers/db";
import { seedProject, type Owner } from "../helpers/seed";

/** The persona's Owner id tuple for seeding. */
function ownerId(s: { userId?: string; orgId?: string }): Owner {
	return { userId: s.userId!, orgId: s.orgId! };
}

/** How many projects the org holds under exactly this display name (case-insensitively). */
async function projectCount(orgId: string, name: string): Promise<number> {
	const [{ count }] = await db()<{ count: number }[]>`
		select count(*)::int as count from projects
		where org_id = ${orgId} and lower(project_name) = lower(${name})
	`;
	return count;
}

// The Configure step calls `getCloudConnectSetup()` — the per-provider health probe that makes
// `~/connectors` slow. Every create below loads it.
test.describe("Projects — create validation", () => {
	test.describe.configure({ timeout: 120_000 });

	test("an empty name is refused with the schema's own message", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/new?scratch=blank`);
		const create = owner.page.getByRole("button", { name: /create project/i });
		await expect(create).toBeVisible({ timeout: 45_000 });
		await create.click();
		// `project-form.schema.ts` states this rule as `.min(1, "Project name is required")`, and
		// #4269 made the Configure step say it in those words rather than "Name your project.".
		await expect(owner.page.getByText(/project name is required/i)).toBeVisible({
			timeout: 15_000,
		});
		await expect(owner.page).toHaveURL(/\/~\/new/);
	});

	test("a name that slugs away entirely is refused (needs a letter or number)", async ({
		owner,
	}) => {
		await owner.page.goto(`/${owner.orgSlug}/~/new?scratch=blank`);
		const name = owner.page.getByLabel(/project name/i);
		await expect(name).toBeVisible({ timeout: 45_000 });
		await name.fill("!!! @@@ ###");
		await owner.page.getByRole("button", { name: /create project/i }).click();
		// The schema's second rule — `.refine(canSlugify, "Enter at least one letter or number")`.
		// Before #4269 the Configure step ran neither, and this name created a project whose slug
		// came from `slugify`'s FALLBACK: `/{org}/project`.
		await expect(
			owner.page.getByText(/enter at least one letter or number/i),
		).toBeVisible({ timeout: 15_000 });
		expect(await projectCount(owner.orgId!, "!!! @@@ ###")).toBe(0);
	});

	test("the import bridge says so when the scan it was handed does not exist", async ({
		owner,
	}) => {
		// `?scan=<jobId>` is the other way into Configure. A well-formed id that names no job
		// resolves NOT_FOUND, and the screen has to say that rather than sit on a spinner — a
		// stale bookmark and a scan still running must not look alike.
		await owner.page.goto(`/${owner.orgSlug}/~/new?scan=${randomUUID()}`);
		await expect(
			owner.page.getByRole("heading", { name: "Configure your project" }),
		).toBeVisible({ timeout: 45_000 });
		await expect(owner.page.getByText(/find that scan/i)).toBeVisible({ timeout: 15_000 });
	});
});

test.describe("Projects — the member is refused a create", () => {
	test.describe.configure({ timeout: 180_000 });

	// The `member` persona is a reduced-permission member of the `team` persona's org — Better
	// Auth's `member` role, which `org-access-control.ts` maps to Alethia's `viewer`, and a viewer
	// holds no `project:create`. Asserted as a DIFFERENCE and not as an absolute, because
	// `_persona-integrity.spec.ts` is emphatic about why: an org that refuses everybody, or a
	// persona with no membership at all, makes a bare "the member was refused" green while
	// measuring nothing. The owner of the SAME org runs the same flow in the same test.
	test("a member is refused the create that the owner of the same org completes", async ({
		member,
		team,
	}) => {
		const stamp = Date.now();
		const denied = `e2e-rbac-member-${stamp}`;
		const allowed = `e2e-rbac-owner-${stamp}`;

		await member.page.goto(`/${member.orgSlug}/~/new?scratch=blank`);
		const memberName = member.page.getByLabel(/project name/i);
		await expect(memberName).toBeVisible({ timeout: 60_000 });
		await memberName.fill(denied);
		await member.page.getByRole("button", { name: /create project/i }).click();
		// A generous window: passing this by being slow would be indistinguishable from passing by
		// being refused, so wait long enough that a successful create would certainly have landed.
		await member.page.waitForTimeout(8_000);
		await expect(member.page).toHaveURL(/\/~\/new/);

		await team.page.goto(`/${team.orgSlug}/~/new?scratch=blank`);
		const ownerName = team.page.getByLabel(/project name/i);
		await expect(ownerName).toBeVisible({ timeout: 60_000 });
		await ownerName.fill(allowed);
		await team.page.getByRole("button", { name: /create project/i }).click();
		await team.page.waitForURL(
			new RegExp(`/${team.orgSlug}/[^/~][^/]*(/architecture)?(\\?|$)`),
			{ timeout: 60_000 },
		);

		// The difference, in rows rather than in wording: a Next server action can redact a thrown
		// Error's message in a production build, so the toast text is not a safe thing to key on.
		expect(await projectCount(member.orgId!, denied)).toBe(0);
		expect(await projectCount(team.orgId!, allowed)).toBe(1);
	});
});

test.describe("Projects — duplicate name behavior", () => {
	test.describe.configure({ timeout: 120_000 });

	// INVERTED by #3145, and the old comment here is worth keeping as history: it read "the app
	// does NOT refuse a duplicate project name ... the orientation hint's 'should be refused' does
	// not match the implementation". The hint was right and the implementation has changed.
	// `projects_org_id_project_name_key` is UNIQUE on (org_id, lower(project_name)), and
	// insertProjectWithDefaultFabric refuses a taken name rather than deriving `api-2` behind the
	// user's back — the slug is derived and may be suffixed, the display name is theirs and is the
	// token `alethia project get <name>` addresses.
	//
	// Asserted on BEHAVIOUR (no navigation, no second project) rather than on the toast text.
	// configure-project.tsx surfaces the failure as `toast.error(err.message)`, but a Next server
	// action can redact a thrown Error's message in a production build, so the wording is not a
	// safe thing for an e2e run to key on. Staying put is the refusal, however it is worded.
	test("a duplicate display name is refused, and no second project is created", async ({
		owner,
	}) => {
		const name = `e2e-dupe-${Date.now()}`;
		const first = await seedProject(ownerId(owner), { name, status: "DRAFT" });
		await owner.page.goto(`/${owner.orgSlug}/~/new?scratch=blank`);
		const field = owner.page.getByLabel(/project name/i);
		await expect(field).toBeVisible({ timeout: 45_000 });
		await field.fill(name);
		await owner.page.getByRole("button", { name: /create project/i }).click();

		// It must NOT navigate to a project. Given a generous window: passing this by being slow
		// would be indistinguishable from passing by being correct, so the wait is long enough
		// that a successful create would certainly have landed.
		await owner.page.waitForTimeout(5_000);
		await expect(owner.page).toHaveURL(/\/~\/new/);
		await expect(owner.page).not.toHaveURL(
			new RegExp(`/${owner.orgSlug}/${first.slug}(/|$)`),
		);
		// "AND NO SECOND PROJECT IS CREATED" — the half of this test's own name that nothing was
		// checking. Staying on the form is consistent with a refusal AND with a create that
		// succeeded while the redirect failed, and the two differ by exactly one row.
		expect(await projectCount(owner.orgId!, name)).toBe(1);
	});

	test("a name differing only in CASE is refused too", async ({ owner }) => {
		// The index is on lower(project_name). A plain unique on the bare column would pass the
		// test above and fail this one, which is the difference the migration chose deliberately.
		const name = `e2e-case-${Date.now()}`;
		await seedProject(ownerId(owner), { name, status: "DRAFT" });
		await owner.page.goto(`/${owner.orgSlug}/~/new?scratch=blank`);
		const field = owner.page.getByLabel(/project name/i);
		await expect(field).toBeVisible({ timeout: 45_000 });
		await field.fill(name.toUpperCase());
		await owner.page.getByRole("button", { name: /create project/i }).click();
		await owner.page.waitForTimeout(5_000);
		await expect(owner.page).toHaveURL(/\/~\/new/);
		expect(await projectCount(owner.orgId!, name)).toBe(1);
	});
});

test.describe("Projects — delete guard on a live environment", () => {
	test("delete is refused while an environment is ACTIVE", async ({ owner }) => {
		const project = await seedProject(ownerId(owner), {
			name: `e2e-live-${Date.now()}`,
			status: "ACTIVE", // default env ACTIVE → in LIVE_ENV_STATUSES
		});
		await owner.page.goto(`/${owner.orgSlug}/${project.slug}/settings/general`);
		await owner.page.getByRole("button", { name: /^Delete project$/ }).click({ timeout: 15_000 });
		const dialog = owner.page.getByRole("alertdialog");
		await dialog.getByRole("button", { name: /delete project/i }).click();
		// Server refuses; an error toast surfaces and we stay on the settings page.
		await expect(owner.page.getByText(/live or in-flight/i)).toBeVisible({ timeout: 15_000 });
		await expect(owner.page).toHaveURL(/\/settings\/general/);
	});
});

test.describe("Projects — environment guards", () => {
	test("New Environment requires a name", async ({ owner }) => {
		const project = await seedProject(ownerId(owner), {
			name: `e2e-envguard-${Date.now()}`,
			status: "DRAFT",
		});
		await owner.page.goto(`/${owner.orgSlug}/${project.slug}/environments`);
		await owner.page.getByRole("button", { name: /new environment/i }).click();
		const dialog = owner.page.getByRole("dialog");
		// Submit with a blank name → a validation toast, and the dialog stays open.
		await dialog.getByRole("button", { name: /create environment/i }).click();
		await expect(owner.page.getByText(/environment name is required/i)).toBeVisible({
			timeout: 15_000,
		});
		await expect(dialog).toBeVisible();
	});
});

test.describe("Projects — not-found + auth", () => {
	test("an unknown project slug renders a not-found page", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/no-such-project-${Date.now()}/architecture`);
		// notFound() → no design canvas; a 404 surface instead.
		await expect(owner.page.getByRole("button", { name: "Add", exact: true })).toHaveCount(0);
		// Assert the PROJECT copy, not any 404. The old `/not found|could not be found|404/i`
		// also matched `[org]/not-found.tsx`'s "Organization not found", which is exactly the
		// wrong answer #3880 fixed — so this spec passed both before and after and could not
		// tell a regression from a fix. `[project]/not-found.tsx` renders "Project not found".
		await expect(
			owner.page.getByText(/project not found/i).first(),
		).toBeVisible({ timeout: 15_000 });
	});

	test("project surfaces do not bounce an authenticated persona to /login", async ({ owner }) => {
		const project = await seedProject(ownerId(owner), {
			name: `e2e-auth-${Date.now()}`,
			status: "DRAFT",
		});
		for (const sub of ["architecture", "environments", "jobs", "clusters", "settings/general"]) {
			await owner.page.goto(`/${owner.orgSlug}/${project.slug}/${sub}`);
			await expect(owner.page, `sub=${sub}`).not.toHaveURL(/\/login/);
		}
	});
});

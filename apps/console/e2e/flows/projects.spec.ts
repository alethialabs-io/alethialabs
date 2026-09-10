// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// E2E — Projects domain (happy paths + empty states). Covers the rebuilt create surface
// (`/{org}/~/new`), the org overview projects grid, the project Architecture design canvas, the
// Environments management view (add / duplicate / delete), project General settings (rename) and
// the project delete flow. Negative / guard / validation paths live in projects.negative.spec.ts.
//
// WHAT `/{org}/~/new` IS NOW, because this file used to describe a page that no longer exists.
// It was one manual form — numbered "Project / Template / Cloud" blocks, a "Create empty project"
// button beside a "Create project" one — and 12 of this file's 20 tests were driving it. It is
// TWO STEPS now (`app/(private)/[org]/~/new/page.tsx` branches on the query string):
//
//   step 1, bare `~/new`      the front door: an "Provision the future." composer that hands its
//                             prompt to the Elench modal, "Import Git Repository" (the repo
//                             picker, or the GitHub/GitLab/Bitbucket link buttons when no git
//                             account is linked), and "Start from scratch" — four tiles.
//   step 2, `?scratch=<kind>` Configure: name, cloud + region, environments → creates a DRAFT and
//        or `?scan=<jobId>`   opens its canvas. The cloud is REQUIRED for the template and import
//                             paths and not for blank/BYO, which is what makes a name-only create
//                             hermetic here.
//
// There is no "Create empty project" button any more, and no template tiles: the standard template
// is a scratch tile that hands off to Configure, which picks the preset itself.
//
// Run (self-check):
//   REUSE_AUTH=1 E2E_BASE_URL=http://localhost:3100 DEV_CONSOLE_LOG=/tmp/alethia-qa-console.log \
//     E2E_WORKERS=1 E2E_RETRIES=1 npx playwright test e2e/flows/projects.spec.ts \
//     --output=test-results/wf-projects
//
// Isolation: seeds are uniquely named (`e2e-*-${Date.now()}`) and scoped to the persona org. We do
// NOT call cleanupOrg (sibling QA agents share this persona org during the parallel run).

import { test, expect } from "../fixtures/qa";
import { scanA11y } from "../helpers/a11y";
import { db } from "../helpers/db";
import {
	seedCloudIdentity,
	seedProject,
	type Owner,
	type SeededProject,
} from "../helpers/seed";

/** Small helper: the persona's Owner id tuple for seeding. */
function ownerId(s: { userId?: string; orgId?: string }): Owner {
	return { userId: s.userId!, orgId: s.orgId! };
}

/**
 * The connector NAMES the cloud picker renders, which are the catalog's display names and not the
 * slugs — the tiles read "Amazon Web Services" and "Google Cloud", never "aws" / "gcp".
 * `seedCloudIdentity` takes the slug. Both come from `lib/db/seed/connectors.generated.sql`.
 */
const AWS_CONNECTOR = "Amazon Web Services";
const GCP_CONNECTOR = "Google Cloud";

/**
 * The cloud identity a project was created against, by display name. The pick's OUTCOME: the
 * screen's selection is only meaningful if it reaches the row.
 */
async function projectCloudIdentity(
	orgId: string,
	name: string,
): Promise<string | null> {
	const rows = await db()<{ cloud_identity_id: string | null }[]>`
		select cloud_identity_id from projects
		where org_id = ${orgId} and lower(project_name) = lower(${name})
		limit 1
	`;
	return rows[0]?.cloud_identity_id ?? null;
}

test.describe("Projects — the create front door (/~/new)", () => {
	test("opens on the composer and both on-ramps, with none of the retired manual form", async ({
		owner,
	}) => {
		await owner.page.goto(`/${owner.orgSlug}/~/new`);
		await expect(
			owner.page.getByRole("heading", { name: /provision the future/i }),
		).toBeVisible({ timeout: 15_000 });
		await expect(owner.page).not.toHaveURL(/\/login/);
		// The composer and its submit control.
		await expect(owner.page.getByPlaceholder(/ask the design agent/i)).toBeVisible();
		await expect(
			owner.page.getByRole("button", { name: "Design with the agent" }),
		).toBeVisible();
		// The two source columns.
		await expect(owner.page.getByText("Import Git Repository")).toBeVisible();
		await expect(owner.page.getByText("Start from scratch")).toBeVisible();
		// The retired manual form is asserted ABSENT rather than left unmentioned: its controls are
		// what this file used to drive, and a front door that grew them back would otherwise be
		// indistinguishable from one that never had them.
		await expect(
			owner.page.getByRole("button", { name: /create empty project/i }),
		).toHaveCount(0);
	});

	test("an example prompt seeds the composer", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/new`);
		const composer = owner.page.getByPlaceholder(/ask the design agent/i);
		await expect(composer).toBeVisible({ timeout: 15_000 });
		await expect(composer).toHaveValue("");
		// The chips render the example's head (everything before its em dash) and set the FULL
		// example as the prompt, so the assertion is containment, not equality.
		await owner.page
			.getByRole("button", { name: /an eks cluster for an ai inference api/i })
			.click();
		await expect(composer).toHaveValue(/EKS cluster for an AI inference API/i);
	});

	test("Import Git Repository offers GitHub, GitLab and Bitbucket linking", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/new`);
		await expect(
			owner.page.getByRole("heading", { name: "Import a repository" }),
		).toBeVisible({ timeout: 15_000 });
		// The QA personas sign up with an emailed code and link no git account, so the panel renders
		// its unlinked branch. These are PRESENCE assertions and nothing clicks them: each one calls
		// `authClient.linkSocial`, which navigates the browser to the provider's OAuth consent screen
		// — off-origin, unauthenticated, and the end of the run.
		//
		// The explicit timeouts are not decoration. The heading is server-rendered and paints with
		// the route; the branch below it does NOT — `RepositorySelector` renders a skeleton until
		// `getLinkedProviders()` (a server action round-trip) resolves. So the default 5 s
		// per-assertion budget starts AFTER the heading is already up, against a call that has not
		// been made yet, and a slow leg would read as "the console stopped offering git import".
		await expect(owner.page.getByText(/no git accounts linked/i)).toBeVisible({
			timeout: 30_000,
		});
		for (const provider of ["GitHub", "GitLab", "Bitbucket"]) {
			await expect(
				owner.page.getByRole("button", { name: `Link ${provider}` }),
			).toBeVisible({ timeout: 30_000 });
		}
	});

	test("the scratch tiles are named by their titles", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/new`);
		await expect(
			owner.page.getByRole("heading", { name: /provision the future/i }),
		).toBeVisible({ timeout: 15_000 });
		// `exact` is the point of the assertion. Before #4269 a tile's accessible name was its
		// title, its two-line description and its "New" pill run together, so it changed with the
		// marketing copy and no exact name existed to ask for. The two ungated tiles are asserted;
		// BYO Helm / BYO IaC ride server flags and are not guaranteed on every leg.
		await expect(
			owner.page.getByRole("button", { name: "Start from a template", exact: true }),
		).toBeVisible();
		await expect(
			owner.page.getByRole("button", { name: "Blank project", exact: true }),
		).toBeVisible();
	});

	test("the front door has no serious a11y violations", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/new`);
		await owner.page.getByRole("heading", { name: /provision the future/i }).waitFor();
		const violations = await scanA11y(owner.page);
		// axe is optional locally (no-ops to []); only fail when it actually finds serious issues.
		expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
	});
});

// Every test below loads the Configure step, and that step calls `getCloudConnectSetup()` — the
// same per-provider health probe + pending-identity insert that makes `~/connectors` slow, which
// `connectors.spec.ts` already raises its whole file's timeout for. Same reason, same remedy.
test.describe("Projects — start from scratch → Configure", () => {
	test.describe.configure({ timeout: 120_000 });

	test("the Blank tile hands off to Configure with a blank source rail", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/new`);
		await owner.page
			.getByRole("button", { name: "Blank project", exact: true })
			.click({ timeout: 20_000 });
		await owner.page.waitForURL(/\/~\/new\?scratch=blank(&|$)/, { timeout: 30_000 });
		await expect(
			owner.page.getByRole("heading", { name: "Configure your project" }),
		).toBeVisible({ timeout: 45_000 });
		// The left rail names the source it came from, which is the only thing on the screen that
		// distinguishes the blank path from the template one.
		await expect(owner.page.getByText("an empty canvas")).toBeVisible();
	});

	test("the project name field derives a live slug preview", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/new?scratch=blank`);
		const name = owner.page.getByLabel(/project name/i);
		await expect(name).toBeVisible({ timeout: 45_000 });
		await name.fill("My Shiny App");
		await expect(name).toHaveValue("My Shiny App");
		// The mono preview under the field shows the slugified name under the org.
		await expect(owner.page.getByText("my-shiny-app")).toBeVisible();
	});

	test("Back to source returns to the front door", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/new?scratch=blank`);
		await expect(
			owner.page.getByRole("heading", { name: "Configure your project" }),
		).toBeVisible({ timeout: 45_000 });
		await owner.page.getByRole("button", { name: "Back to source" }).click();
		await expect(
			owner.page.getByRole("heading", { name: /provision the future/i }),
		).toBeVisible({ timeout: 30_000 });
	});

	test("a name-only create on the Blank path opens the new project's canvas", async ({
		owner,
	}) => {
		await owner.page.goto(`/${owner.orgSlug}/~/new?scratch=blank`);
		const uniq = `e2e-blank-${Date.now()}`;
		const name = owner.page.getByLabel(/project name/i);
		await expect(name).toBeVisible({ timeout: 45_000 });
		await name.fill(uniq);
		// No cloud is selected and none is needed: `requiresCloud` is false for the blank path, so
		// the button is live on a name alone. This is the replacement for the old "Create empty
		// project" test, and it is the same promise.
		await owner.page.getByRole("button", { name: /create project/i }).click();
		// Lands on the new project (a bare project URL redirects to /architecture).
		await owner.page.waitForURL(
			new RegExp(`/${owner.orgSlug}/[^/~][^/]*(/architecture)?(\\?|$)`),
			{ timeout: 60_000 },
		);
		await expect(owner.page).not.toHaveURL(/\/~\/new/);
	});
});

test.describe("Projects — the template path", () => {
	test.describe.configure({ timeout: 120_000 });

	test("the Template tile hands off to Configure with a cloud step", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/new`);
		await owner.page
			.getByRole("button", { name: "Start from a template", exact: true })
			.click({ timeout: 20_000 });
		await owner.page.waitForURL(/\/~\/new\?scratch=template(&|$)/, { timeout: 30_000 });
		await expect(
			owner.page.getByRole("heading", { name: "Configure your project" }),
		).toBeVisible({ timeout: 45_000 });
		// THE ASSERTIONS ARE THE TEMPLATE PATH'S OWN, and this is a correction: the pair of them
		// used to be "Standard template" plus the "Cloud & region" heading, described as "the step
		// the template path adds over the blank one". It is not a step it adds — `configure-project`
		// renders `<Section n="02" title="Cloud & region">` UNCONDITIONALLY, for blank, byo-helm,
		// byo-iac and import alike; only `requiresCloud` differs between the paths, and it gates the
		// Notice and the Create button's label, not that heading. Swapping `?scratch=template` for
		// `?scratch=blank` on the click above left the test green, so it could not tell the
		// hand-off it names from the one the sibling test covers.
		//
		// `SCRATCH_META` is what actually differs, and the left rail renders it: the blank test
		// keys on "an empty canvas", so this one keys on the template's label AND one-liner and
		// asserts the blank marker ABSENT. The cloud REQUIREMENT is the other real difference, but
		// its only visible forms — the "Connect a cloud account…" notice and the disabled "Connect
		// a cloud to continue" button — appear only on an org with no connected cloud, and this
		// file's persona org is shared with sibling QA workers that seed cloud identities into it
		// and never clean up. It is not a precondition this spec can establish.
		await expect(owner.page.getByText("Standard template")).toBeVisible();
		await expect(owner.page.getByText("start from a template")).toBeVisible();
		await expect(owner.page.getByText("an empty canvas")).toHaveCount(0);
	});

	test("each cloud tile is a named group, and a seeded account reads Connected", async ({
		owner,
	}) => {
		await seedCloudIdentity(ownerId(owner), { provider: "aws" });
		await owner.page.goto(`/${owner.orgSlug}/~/new?scratch=template`);
		await expect(
			owner.page.getByRole("heading", { name: "Configure your project" }),
		).toBeVisible({ timeout: 45_000 });
		// #4269's product half: a pick-mode connector tile was a bare `<div onClick>` with no role
		// and no name, so nothing but `getByText("AWS")` reached it — and that matches the status
		// copy and the region row too. Each tile is a named `group` now.
		const aws = owner.page.getByRole("group", { name: AWS_CONNECTOR });
		await expect(aws).toBeVisible({ timeout: 30_000 });
		await expect(aws.getByText("Connected")).toBeVisible();
	});

	test("a template create on a connected cloud opens the new project's canvas", async ({
		owner,
	}) => {
		// TWO CLOUDS, AND THE PICK IS MEASURED — this test used to seed one AWS identity, click the
		// AWS tile and assert the Create button was enabled. `deriveInitial()` pre-selects the FIRST
		// connected cloud identity, so `identityId` was already non-null on first render: the button
		// was enabled and the create succeeded whatever the click did. Regressing `CloudPicker`'s
		// `onSelect` to a no-op, or dropping `ConnectorCard`'s `onClick={isPick ? onSelect : …}`,
		// left it green. Nothing measured the pick path at all.
		//
		// So: seed AWS *and* GCP, click each tile in turn, and assert the REGION follows — `onCloud`
		// sets `DEFAULT_REGION[provider]`, so the region row reads eu-west-1 after the AWS tile and
		// europe-west1 after the GCP one. Whichever of the two the form pre-selected, one of those
		// two assertions is a real state change, and a click that does nothing fails it. The create
		// then lands on GCP, and the created ROW is checked: `cloud_identity_id` must be the GCP
		// identity, not the AWS one the form opened on.
		const aws = await seedCloudIdentity(ownerId(owner), { provider: "aws" });
		const gcp = await seedCloudIdentity(ownerId(owner), { provider: "gcp" });
		await owner.page.goto(`/${owner.orgSlug}/~/new?scratch=template`);
		const uniq = `e2e-template-${Date.now()}`;
		const name = owner.page.getByLabel(/project name/i);
		await expect(name).toBeVisible({ timeout: 45_000 });
		await name.fill(uniq);

		await owner.page
			.getByRole("group", { name: AWS_CONNECTOR })
			.click({ timeout: 30_000 });
		await expect(owner.page.getByText("eu-west-1")).toBeVisible({ timeout: 15_000 });
		await owner.page.getByRole("group", { name: GCP_CONNECTOR }).click();
		await expect(owner.page.getByText("europe-west1")).toBeVisible({ timeout: 15_000 });
		await expect(owner.page.getByText("eu-west-1")).toHaveCount(0);

		const create = owner.page.getByRole("button", { name: /create project/i });
		await expect(create).toBeEnabled();
		await create.click();
		await owner.page.waitForURL(
			new RegExp(`/${owner.orgSlug}/[^/~][^/]*(/architecture)?(\\?|$)`),
			{ timeout: 60_000 },
		);
		await expect(owner.page).not.toHaveURL(/\/~\/new/);
		// The outcome the pick is FOR. A create that quietly kept the pre-selected identity would
		// pass every assertion above the fold and put the project on the wrong cloud.
		expect(await projectCloudIdentity(owner.orgId!, uniq)).toBe(gcp.id);
		expect(await projectCloudIdentity(owner.orgId!, uniq)).not.toBe(aws.id);
	});
});

test.describe("Projects — org overview grid", () => {
	// The Create-menu test navigates INTO `~/new` and waits for it to paint — a route first-compile
	// on top of the overview's own, inside one test budget.
	test.slow();

	test("empty-filter search on a seeded project narrows the grid", async ({ owner }) => {
		const project = await seedProject(ownerId(owner), {
			name: `e2e-grid-${Date.now()}`,
			status: "DRAFT",
		});
		await owner.page.goto(`/${owner.orgSlug}`);
		// The seeded project card is on the grid.
		await expect(owner.page.getByText(project.name, { exact: false }).first()).toBeVisible({
			timeout: 15_000,
		});
		// A no-match query yields the empty-filter copy.
		const search = owner.page.getByPlaceholder(/search/i).first();
		await search.fill(`zzz-no-such-project-${Date.now()}`);
		await expect(owner.page.getByText(/no projects match your filters/i)).toBeVisible();
	});

	test("the Create menu reaches the create-project front door", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		// The toolbar's popover is "Create", not the "Add new" this test used to click, and its
		// entries are menu items rather than buttons.
		await owner.page
			.getByRole("button", { name: "Create", exact: true })
			.click({ timeout: 15_000 });
		await owner.page.getByRole("menuitem", { name: "Project", exact: true }).click();
		await owner.page.waitForURL(/\/~\/new(\?|$)/, { timeout: 20_000 });
		// The URL is not the arrival — a client-side push lands there before `~/new` has compiled,
		// and this budget is the whole first hit of a route under three parallel workers. At 20 s it
		// flaked once and passed on the retry, which is a cost the ratchet forgives and a reader
		// does not: an intermittent red here reads as "the Create menu stopped working".
		await expect(
			owner.page.getByRole("heading", { name: /provision the future/i }),
		).toBeVisible({ timeout: 60_000 });
	});
});

test.describe("Projects — Architecture design canvas", () => {
	let project: SeededProject;

	test.beforeEach(async ({ owner }) => {
		project = await seedProject(ownerId(owner), {
			name: `e2e-arch-${Date.now()}`,
			status: "DRAFT",
		});
	});

	test("canvas loads with the Add and More affordances", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/${project.slug}/architecture`);
		await expect(owner.page).not.toHaveURL(/\/login/);
		await expect(
			owner.page.getByRole("button", { name: "Add", exact: true }).first(),
		).toBeVisible({ timeout: 20_000 });
		// The board's toolbar is `[cost] [Run ▾] [Add] [⋯]`. The "Project settings" cog this used to
		// assert was removed in #554 — the project root is edited from its board card — so asserting
		// it made a passing canvas look broken. `More` is the control that replaced it.
		await expect(
			owner.page.getByRole("button", { name: "More", exact: true }),
		).toBeVisible();
	});

	test("Add opens the service palette which accepts a search query", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/${project.slug}/architecture`);
		await owner.page
			.getByRole("button", { name: "Add", exact: true })
			.first()
			.click({ timeout: 20_000 });
		const search = owner.page.getByPlaceholder(/search services/i);
		await expect(search).toBeVisible();
		await search.fill("database");
		await expect(search).toHaveValue("database");
	});

	test("bare project URL redirects to Architecture", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/${project.slug}`);
		await owner.page.waitForURL(/\/architecture(\?|$)/, { timeout: 20_000 });
		await expect(owner.page).not.toHaveURL(/\/login/);
	});
});

test.describe("Projects — Environments view", () => {
	let project: SeededProject;

	// The environments view runs three per-env enrichment probes on load and refreshes after each
	// mutation — heavy first-compile under parallel load, so give these extra headroom.
	test.slow();

	test.beforeEach(async ({ owner }) => {
		project = await seedProject(ownerId(owner), {
			name: `e2e-envs-${Date.now()}`,
			status: "DRAFT",
		});
	});

	/**
	 * The per-row delete control. `environment-card.tsx` gives it `title="Delete"` and nothing else,
	 * so its accessible name carries no environment — every non-default row on the page offers an
	 * identically-named button. That is a real testid gap (filed in the PR for #4269, not worked
	 * around by editing app code from here); a seeded project has exactly ONE environment, so after
	 * adding one there is exactly one deletable row and the name is unambiguous. Each test that uses
	 * this asserts the count first, so a page that grows a second one fails by saying so rather than
	 * by Playwright's strict-mode error.
	 */
	function deleteControls(page: import("@playwright/test").Page) {
		return page.getByRole("button", { name: "Delete", exact: true });
	}

	test("lists the default environment with a Default tag and no delete control", async ({
		owner,
	}) => {
		await owner.page.goto(`/${owner.orgSlug}/${project.slug}/environments`, {
			waitUntil: "domcontentloaded",
		});
		await expect(owner.page.getByRole("heading", { name: /^environments$/i })).toBeVisible({
			timeout: 15_000,
		});
		await expect(owner.page.getByRole("link", { name: "production" })).toBeVisible();
		await expect(owner.page.getByText(/^default$/i).first()).toBeVisible();
		// The default env is undeletable, and `environment-card.tsx` renders NO delete button for
		// it. This assertion used to be `/delete production/i`, a name no control on this page has
		// ever had — it could only ever be 0, so it passed whatever the page did.
		await expect(deleteControls(owner.page)).toHaveCount(0);
	});

	test("New Environment (empty) creates an environment that then lists", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/${project.slug}/environments`, {
			waitUntil: "domcontentloaded",
		});
		await owner.page.getByRole("button", { name: /new environment/i }).click();
		const dialog = owner.page.getByRole("dialog");
		await expect(dialog.getByText(/new environment/i).first()).toBeVisible();
		const envName = `stg${Date.now().toString().slice(-6)}`;
		await dialog.getByLabel(/environment name/i).fill(envName);
		// Pick the "Empty Environment" mode so no base-env selection is required.
		await dialog.getByRole("button", { name: /empty environment/i }).click();
		await dialog.getByRole("button", { name: /create environment/i }).click();
		// The new env appears in the list.
		await expect(owner.page.getByRole("link", { name: envName })).toBeVisible({
			timeout: 20_000,
		});
	});

	test("Duplicate Environment copies the default base", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/${project.slug}/environments`, {
			waitUntil: "domcontentloaded",
		});
		await owner.page.getByRole("button", { name: /new environment/i }).click();
		const dialog = owner.page.getByRole("dialog");
		const envName = `dup${Date.now().toString().slice(-6)}`;
		await dialog.getByLabel(/environment name/i).fill(envName);
		// Duplicate mode is the default; the base defaults to the default env.
		await dialog.getByRole("button", { name: /duplicate environment/i }).click();
		await dialog.getByRole("button", { name: /create environment/i }).click();
		await expect(owner.page.getByRole("link", { name: envName })).toBeVisible({
			timeout: 20_000,
		});
	});

	test("a non-default environment can be deleted", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/${project.slug}/environments`, {
			waitUntil: "domcontentloaded",
		});
		// First create one to delete.
		await owner.page.getByRole("button", { name: /new environment/i }).click();
		const dialog = owner.page.getByRole("dialog");
		const envName = `del${Date.now().toString().slice(-6)}`;
		await dialog.getByLabel(/environment name/i).fill(envName);
		await dialog.getByRole("button", { name: /empty environment/i }).click();
		await dialog.getByRole("button", { name: /create environment/i }).click();
		await expect(owner.page.getByRole("link", { name: envName })).toBeVisible({
			timeout: 20_000,
		});

		// Exactly one deletable row: the one just added. Asserted before it is clicked, so an extra
		// row states itself instead of surfacing as a strict-mode violation on the line below.
		await expect(deleteControls(owner.page)).toHaveCount(1);
		await deleteControls(owner.page).click();
		// The confirm is a ConfirmDialog whose TITLE names the environment — that is where the row's
		// identity is, since the trigger's name is the bare word "Delete".
		const confirm = owner.page.getByRole("alertdialog");
		await expect(confirm.getByText(new RegExp(`delete ${envName}`, "i"))).toBeVisible();
		await confirm.getByRole("button", { name: /delete environment/i }).click();
		await expect(owner.page.getByRole("link", { name: envName })).toHaveCount(0, {
			timeout: 20_000,
		});
	});
});

test.describe("Projects — General settings", () => {
	test.slow(); // first-compile of the settings route is slow under parallel load.

	test("General page renders the rename form and stable slug", async ({ owner }) => {
		const project = await seedProject(ownerId(owner), {
			name: `e2e-set-${Date.now()}`,
			status: "DRAFT",
		});
		await owner.page.goto(`/${owner.orgSlug}/${project.slug}/settings/general`, {
			waitUntil: "domcontentloaded",
		});
		await expect(owner.page.getByText(/project profile/i)).toBeVisible({ timeout: 15_000 });
		await expect(owner.page.getByText(new RegExp(`/${owner.orgSlug}/${project.slug}`))).toBeVisible();
	});

	test("renaming a project persists (Save enables + succeeds)", async ({ owner }) => {
		const project = await seedProject(ownerId(owner), {
			name: `e2e-ren-${Date.now()}`,
			status: "DRAFT",
		});
		await owner.page.goto(`/${owner.orgSlug}/${project.slug}/settings/general`, {
			waitUntil: "domcontentloaded",
		});
		const nameInput = owner.page.getByRole("textbox").first();
		await expect(nameInput).toBeVisible({ timeout: 15_000 });
		const newName = `e2e-renamed-${Date.now()}`;
		await nameInput.fill(newName);
		const save = owner.page.getByRole("button", { name: /save changes/i });
		await expect(save).toBeEnabled();
		await save.click();
		await expect(owner.page.getByText(/project updated/i)).toBeVisible({ timeout: 15_000 });
	});
});

test.describe("Projects — delete (non-live)", () => {
	test.slow();

	test("deleting a DRAFT project returns to the org overview", async ({ owner }) => {
		const project = await seedProject(ownerId(owner), {
			name: `e2e-del-${Date.now()}`,
			status: "DRAFT",
		});
		await owner.page.goto(`/${owner.orgSlug}/${project.slug}/settings/general`, {
			waitUntil: "domcontentloaded",
		});
		// The registry entry `project.delete` in `destructive-actions.yaml`: control
		// `{ role: button, name: "Delete project" }` — the trigger reads "Delete" but carries
		// `aria-label="Delete project"` (#4463) — an alert-dialog titled "Delete this project?", and
		// a confirm action also named "Delete project".
		await owner.page.getByRole("button", { name: /^Delete project$/ }).click({ timeout: 15_000 });
		const dialog = owner.page.getByRole("alertdialog");
		await expect(dialog.getByText(/delete this project\?/i)).toBeVisible();
		await dialog.getByRole("button", { name: /delete project/i }).click();
		// Back on the org overview, off the project entirely.
		await owner.page.waitForURL(new RegExp(`/${owner.orgSlug}(\\?|/?$)`), { timeout: 20_000 });
		await expect(owner.page).not.toHaveURL(/\/settings\/general/);
	});
});

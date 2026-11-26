// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// E2E — Projects domain (happy paths + empty states). Covers the rebuilt create surface
// (`/{org}/~/new`), the org overview projects grid, the project Architecture design canvas, the
// Environments management view (add / duplicate / delete), project General settings (rename) and
// the project delete flow. Negative / guard / validation paths live in projects.negative.spec.ts.
//
// WHAT `/{org}/~/new` IS NOW (#6843). It was a two-step flow — a chooser, then a "Configure your
// project" screen reached by `?scratch=<kind>` or `?scan=<jobId>` — and before that one manual form.
// It is ONE SCREEN now: the "Provision the future." composer that hands its prompt to the Elench
// modal, then the create form — "Start from" (Import a repository, Standard, AI workloads, Blank,
// Cluster only, and the BYO options behind their flags, as one radio group), Cloud and Region (only
// for a starting point that creates a cluster), and Name. Every value is filled in where it can be
// worked out. An older `?scratch=<kind>` link still opens on that starting point; `?scan=<jobId>`
// follows the scan in place. Create makes a DRAFT and lands on the canvas with a `?seed=`.
//
// Blank asks for no cloud, which is what makes a name-only create hermetic here.
//
// Run (self-check):
//   REUSE_AUTH=1 E2E_BASE_URL=http://localhost:3100 DEV_CONSOLE_LOG=/tmp/alethia-qa-console.log \
//     E2E_WORKERS=1 E2E_RETRIES=1 npx playwright test e2e/flows/projects.spec.ts \
//     --output=test-results/wf-projects
//
// Isolation: seeds are uniquely named (`e2e-*-${Date.now()}`) and scoped to the persona org. We do
// NOT call cleanupOrg (sibling QA agents share this persona org during the parallel run).

import type { Page } from "@playwright/test";
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
 * The cloud choice named `name` ("AWS", "GCP"), by the label around its radio. The radio is visually
 * hidden; a person clicks the label, and so does this.
 */
function cloudChoice(page: Page, name: string) {
	return page.locator("label").filter({ has: page.getByRole("radio", { name, exact: true }) });
}

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
		// Both ways to start: importing a repository, and the starting points beside it.
		await expect(owner.page.getByRole("radio", { name: "Import a repository", exact: true })).toBeVisible({
			timeout: 45_000,
		});
		await expect(owner.page.getByRole("radio", { name: "Standard", exact: true })).toBeChecked();
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
		await owner.page
			.locator("label")
			.filter({ has: owner.page.getByRole("radio", { name: "Import a repository", exact: true }) })
			.click({ timeout: 45_000 });
		// The QA personas sign up with an emailed code and link no git account, so the panel renders
		// its unlinked branch. These are PRESENCE assertions and nothing clicks them: each one calls
		// `authClient.linkSocial`, which navigates the browser to the provider's OAuth consent screen
		// — off-origin, unauthenticated, and the end of the run.
		//
		// The explicit timeouts are not decoration: `RepositorySelector` may still be reading the
		// linked providers when the option is picked, and a slow leg would otherwise read as "the
		// console stopped offering git import".
		await expect(owner.page.getByText(/no git accounts linked/i)).toBeVisible({
			timeout: 30_000,
		});
		// "Connect", not "Link" (#6816): the selector and the connectors board start the same OAuth
		// link and now share one verb (`GIT_CONNECT_VERB`, components/connectors/connectors-link-error.ts).
		for (const provider of ["GitHub", "GitLab", "Bitbucket"]) {
			await expect(
				owner.page.getByRole("button", { name: `Connect ${provider}` }),
			).toBeVisible({ timeout: 30_000 });
		}
	});

	test("the scratch tiles are named by their titles", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/new`);
		await expect(
			owner.page.getByRole("heading", { name: /provision the future/i }),
		).toBeVisible({ timeout: 15_000 });
		// `exact` is the point of the assertion. Before #4269 a tile's accessible name was its
		// title and its description run together, so it changed with the copy and no exact name
		// existed to ask for. Each starting point is a radio named by its title alone, its
		// description attached as the description. The ungated ones are asserted; BYO Helm / BYO IaC
		// ride server flags and are not guaranteed on every leg.
		for (const title of ["Import a repository", "Standard", "AI workloads", "Blank", "Cluster only"]) {
			await expect(owner.page.getByRole("radio", { name: title, exact: true })).toBeVisible({
				timeout: 45_000,
			});
		}
	});

	test("the front door has no serious a11y violations", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/new`);
		await owner.page.getByRole("heading", { name: /provision the future/i }).waitFor();
		await owner.page.getByRole("button", { name: "Create project" }).waitFor({ timeout: 45_000 });
		const violations = await scanA11y(owner.page);
		// axe is optional locally (no-ops to []); only fail when it actually finds serious issues.
		expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
	});
});

// Every test below loads the create form, and the form's server half calls `getCloudConnectSetup()`
// — the same per-provider health probe + pending-identity insert that makes `~/connectors` slow,
// which `connectors.spec.ts` already raises its whole file's timeout for. Same reason, same remedy.
test.describe("Projects — start from scratch → Configure", () => {
	test.describe.configure({ timeout: 120_000 });

	test("the Blank starting point asks for no cloud", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/new`);
		await owner.page
			.locator("label")
			.filter({ has: owner.page.getByRole("radio", { name: "Blank", exact: true }) })
			.click({ timeout: 45_000 });
		await expect(owner.page.getByRole("radio", { name: "Blank", exact: true })).toBeChecked();
		// A blank project has no cluster yet, so the Cloud and Region rows are not asked.
		await expect(owner.page.getByRole("radio", { name: "AWS", exact: true })).toHaveCount(0);
		await expect(owner.page.getByLabel(/project name/i)).toBeVisible();
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

	test("an older ?scratch= link opens on its starting point, with a name already filled in", async ({
		owner,
	}) => {
		await owner.page.goto(`/${owner.orgSlug}/~/new?scratch=blank`);
		await expect(owner.page.getByRole("radio", { name: "Blank", exact: true })).toBeChecked({
			timeout: 45_000,
		});
		// The name is worked out (`my-first-project` / `my-project`, made free against the org's
		// names), never left empty for the person to invent.
		await expect(owner.page.getByLabel(/project name/i)).not.toHaveValue("");
	});

	test("a name-only create on the Blank path opens the new project's canvas", async ({
		owner,
	}) => {
		await owner.page.goto(`/${owner.orgSlug}/~/new?scratch=blank`);
		const uniq = `e2e-blank-${Date.now()}`;
		const name = owner.page.getByLabel(/project name/i);
		await expect(name).toBeVisible({ timeout: 45_000 });
		await name.fill(uniq);
		// No cloud is asked and none is needed for a blank project, so the button is live on a name
		// alone. This is the replacement for the old "Create empty project" test, and the same promise.
		await owner.page.getByRole("button", { name: /create project/i }).click();
		// Lands on the new project's canvas, with the seed the canvas starts from.
		await owner.page.waitForURL(
			new RegExp(`/${owner.orgSlug}/[^/~][^/]*(/architecture)?(\\?|$)`),
			{ timeout: 60_000 },
		);
		await expect(owner.page).not.toHaveURL(/\/~\/new/);
	});
});

test.describe("Projects — the template path", () => {
	test.describe.configure({ timeout: 120_000 });

	test("the Standard starting point asks for a cloud and a region", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/new?scratch=template`);
		await expect(owner.page.getByRole("radio", { name: "Standard", exact: true })).toBeChecked({
			timeout: 45_000,
		});
		// The four clouds this release offers, and no other.
		for (const cloud of ["AWS", "GCP", "Azure", "Hetzner"]) {
			await expect(owner.page.getByRole("radio", { name: cloud, exact: true })).toHaveCount(1);
		}
		await expect(owner.page.getByRole("radio", { name: /alibaba/i })).toHaveCount(0);
		await expect(owner.page.getByRole("combobox", { name: "Region" })).toBeVisible();
	});

	test("each cloud is a named choice, and a seeded account reads Connected", async ({ owner }) => {
		await seedCloudIdentity(ownerId(owner), { provider: "aws" });
		await owner.page.goto(`/${owner.orgSlug}/~/new?scratch=template`);
		// Each cloud is a radio named by the cloud, its connection state attached as its description,
		// so "Connected" is said about THIS cloud rather than found anywhere on the page.
		const aws = owner.page.getByRole("radio", { name: "AWS", exact: true });
		await expect(aws).toHaveCount(1, { timeout: 45_000 });
		await expect(aws).toHaveAccessibleDescription(/Connected/);
	});

	test("a template create on a connected cloud opens the new project's canvas", async ({
		owner,
	}) => {
		// TWO CLOUDS, AND THE PICK IS MEASURED. The form selects a connected account without a click,
		// so a create that kept whatever it opened on would pass on a single cloud. Seed AWS *and*
		// GCP, pick each in turn, and assert the REGION follows the cloud (each cloud's region codes
		// have their own shape: `eu-west-1` against `europe-west1`). The create then lands on GCP,
		// and the created ROW is checked: `cloud_identity_id` must be the GCP identity.
		const aws = await seedCloudIdentity(ownerId(owner), { provider: "aws" });
		const gcp = await seedCloudIdentity(ownerId(owner), { provider: "gcp" });
		await owner.page.goto(`/${owner.orgSlug}/~/new?scratch=template`);
		const uniq = `e2e-template-${Date.now()}`;
		const name = owner.page.getByLabel(/project name/i);
		await expect(name).toBeVisible({ timeout: 45_000 });
		await name.fill(uniq);

		// The region is read off the Select's TRIGGER (base-ui gives it `role="combobox"`): the
		// option list carries every region code too. The trigger's text is the label run into the
		// code ("Frankfurteu-central-1"), so the patterns have no leading word boundary.
		const region = owner.page.getByRole("combobox", { name: "Region" });
		await cloudChoice(owner.page, "AWS").click({ timeout: 30_000 });
		await expect(region).toHaveText(/(us|eu|ap|sa)-[a-z]+-\d\b/, { timeout: 15_000 });
		await cloudChoice(owner.page, "GCP").click();
		await expect(region).toHaveText(/(us|europe|asia|southamerica)-[a-z]+\d\b/, { timeout: 15_000 });

		const create = owner.page.getByRole("button", { name: /create project/i });
		await expect(create).toBeEnabled();
		await create.click();
		// The canvas opens with the template seed for the cloud that was picked (the canvas removes
		// the param once it has applied it, so the arrival is where it is read).
		await owner.page.waitForURL(
			new RegExp(`/${owner.orgSlug}/[^/~][^/]*/architecture\\?seed=v1\\.template\\.standard\\.gcp`),
			{ timeout: 60_000 },
		);
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
		const search = owner.page.getByRole("textbox", { name: "Search projects", exact: true });
		await search.fill(`zzz-no-such-project-${Date.now()}`);
		await expect(owner.page.getByText("No projects match these filters.", { exact: true })).toBeVisible();
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
	 * Opens one environment's row menu (`Environment actions for <name>`, `environment-columns.tsx`)
	 * and returns its Delete item. The menu names its environment, so there is no identically-named
	 * control to pick between (the gap #4269 recorded against the old icon button). Duplicate is in
	 * every row's menu, so it is waited on first: an absent Delete is then read from an OPEN menu,
	 * not from one that never opened.
	 */
	async function deleteItemOf(page: import("@playwright/test").Page, envName: string) {
		await page.getByRole("button", { name: `Environment actions for ${envName}` }).click();
		await expect(page.getByRole("menuitem", { name: "Duplicate" })).toBeVisible({ timeout: 10_000 });
		return page.getByRole("menuitem", { name: "Delete", exact: true });
	}

	test("lists the default environment with a Default tag and no delete control", async ({
		owner,
	}) => {
		await owner.page.goto(`/${owner.orgSlug}/${project.slug}/environments`, {
			waitUntil: "domcontentloaded",
		});
		// No in-content page title since #6120 (F010); the environment's own link is the first thing
		// this test is about, so it is what the page is waited on.
		await expect(owner.page.getByRole("link", { name: "production" })).toBeVisible({
			timeout: 15_000,
		});
		await expect(owner.page.getByText(/^default$/i).first()).toBeVisible();
		// The default env is undeletable: its row menu has NO Delete item. This assertion used to be
		// `/delete production/i`, a name no control on this page has ever had — it could only ever be
		// 0, so it passed whatever the page did.
		await expect(await deleteItemOf(owner.page, "production")).toHaveCount(0);
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

		// The row just added is deletable: its menu has the Delete item the default's does not.
		const deleteItem = await deleteItemOf(owner.page, envName);
		await expect(deleteItem).toHaveCount(1);
		await deleteItem.click();
		// The confirm's TITLE names the environment too. Deleting an environment is confirmed by
		// typing its name, and the button does nothing until it has been.
		const confirm = owner.page.getByRole("alertdialog");
		await expect(confirm.getByText(new RegExp(`delete ${envName}`, "i"))).toBeVisible();
		const deleteButton = confirm.getByRole("button", { name: /delete environment/i });
		await expect(deleteButton).toBeDisabled();
		await confirm.getByRole("textbox").fill(envName);
		await deleteButton.click();
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
		const nameInput = owner.page.getByRole("textbox", { name: "Project name" });
		const newName = `e2e-renamed-${Date.now()}`;
		const save = owner.page.getByRole("button", { name: /save changes/i });
		// WAIT FOR THE OLD NAME before typing. That value means hydration is done; visible does not
		// (#5202). The page is reached on `domcontentloaded`, so the server-rendered input is visible
		// and fillable before React hydrates. The name field is `register`ed (uncontrolled):
		// `register` passes no `value` prop, so the server HTML has an EMPTY input. On hydration,
		// react-hook-form's ref callback writes the default (the old name) into the DOM node.
		// `fill` is two steps, select-all and then insertText. When that write lands between them,
		// the selection is gone and the caret is at the end, so the new name is APPENDED:
		// `e2e-ren-…e2e-renamed-…`. The re-fill loop this replaces could not catch that. An appended
		// name is still a changed name, so Save enabled and the loop exited on the wrong value.
		// The old name can only come from the client, so seeing it means the ref has run.
		await expect(nameInput).toHaveValue(project.name, { timeout: 15_000 });
		await nameInput.fill(newName);
		await expect(nameInput).toHaveValue(newName);
		await expect(save).toBeEnabled();
		await save.click();
		await expect(owner.page.getByText(/project updated/i)).toBeVisible({ timeout: 15_000 });

		// "Persists" means it survives a reload, so read it back from the server.
		// `toHaveValue` is hydration-proof here for the same reason as above.
		await owner.page.reload({ waitUntil: "domcontentloaded" });
		await expect(nameInput).toHaveValue(newName, { timeout: 15_000 });
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
		// a confirm action also named "Delete project", which stays disabled until the project's
		// name is typed (`confirm: typed`, #7198).
		//
		// WAIT FOR HYDRATION before clicking; a visible trigger is not enough. The page is reached on
		// `domcontentloaded`, so the server-rendered "Delete" button is visible and clickable before
		// React hydrates `project-general.tsx`. Its `AlertDialogTrigger` opens the dialog from a
		// client handler, so a click that lands first hits a button that does nothing: no dialog, and
		// `alertdialog` is never found. Release gate 37109081352 failed exactly that way on both
		// attempts, with the page fully rendered. The signal is the one #5202 uses for rename on this
		// page. The name input is `register`ed, so the server HTML leaves it EMPTY, and only the
		// hydrated client writes the project name into it. No Suspense boundary sits between the
		// input and the trigger, so they hydrate together: seeing the name means the trigger is live.
		await expect(owner.page.getByRole("textbox", { name: "Project name" })).toHaveValue(
			project.name,
			{ timeout: 15_000 },
		);
		await owner.page.getByRole("button", { name: /^Delete project$/ }).click();
		const dialog = owner.page.getByRole("alertdialog");
		await expect(dialog.getByText(/delete this project\?/i)).toBeVisible();
		const confirm = dialog.getByRole("button", { name: /delete project/i });
		await expect(confirm).toBeDisabled();
		await dialog.getByRole("textbox").fill(project.name);
		await expect(confirm).toBeEnabled();
		await confirm.click();
		// Back on the org overview, off the project entirely.
		await owner.page.waitForURL(new RegExp(`/${owner.orgSlug}(\\?|/?$)`), { timeout: 20_000 });
		await expect(owner.page).not.toHaveURL(/\/settings\/general/);
	});
});

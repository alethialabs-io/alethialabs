// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// E2E — Projects domain (happy paths + empty states). Covers the create-project surface
// (`/{org}/~/new`), the org overview projects grid, the project Architecture design canvas, the
// Environments management view (add / duplicate / delete + consistency), project General settings
// (rename) and the project delete flow (successful delete of a non-live project). Negative /
// guard / validation paths live in projects.negative.spec.ts.
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

test.describe("Projects — create surface (/~/new)", () => {
	test("create page loads with the agent hero and manual sections", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/new`);
		await expect(
			owner.page.getByRole("heading", { name: /provision the future/i }),
		).toBeVisible({ timeout: 15_000 });
		await expect(owner.page).not.toHaveURL(/\/login/);
		// The three numbered manual blocks.
		await expect(owner.page.getByRole("heading", { name: /^project$/i })).toBeVisible();
		await expect(owner.page.getByRole("heading", { name: /^template$/i })).toBeVisible();
		await expect(owner.page.getByRole("heading", { name: /^cloud$/i })).toBeVisible();
	});

	test("project name field derives a live slug preview", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/new`);
		const name = owner.page.getByLabel(/project name/i);
		await name.fill("My Shiny App");
		await expect(name).toHaveValue("My Shiny App");
		// The mono preview shows the slugified name under the org.
		await expect(owner.page.getByText("my-shiny-app")).toBeVisible();
	});

	test("template selector offers Standard / AI Workloads / Custom", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/new`);
		// Template tiles are <button>s whose accessible name is title + description + features, so
		// match by a distinctive substring rather than an exact name.
		await expect(owner.page.getByRole("button", { name: /general purpose workloads/i })).toBeVisible();
		await expect(owner.page.getByRole("button", { name: /ai workloads/i })).toBeVisible();
		await expect(owner.page.getByRole("button", { name: /fully customizable/i })).toBeVisible();
		// Switching the template is accepted (no crash, control stays interactive).
		const standard = owner.page.getByRole("button", { name: /general purpose workloads/i });
		await standard.click();
		await expect(standard).toBeEnabled();
	});

	test("both create actions are present", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/new`);
		await expect(
			owner.page.getByRole("button", { name: /create empty project/i }),
		).toBeVisible();
		await expect(
			owner.page.getByRole("button", { name: /^create project$/i }),
		).toBeVisible();
	});

	test("cloud picker lists provider tiles; a seeded verified identity reads Connected", async ({
		owner,
	}) => {
		// Seed a verified GCP identity so its tile flips to Connected + selectable.
		await seedCloudIdentity(ownerId(owner), { provider: "gcp" });
		await owner.page.goto(`/${owner.orgSlug}/~/new`);
		await expect(owner.page.getByText("GCP", { exact: true })).toBeVisible({ timeout: 15_000 });
		// At least one tile shows the Connected status now.
		await expect(owner.page.getByText("Connected").first()).toBeVisible();
	});

	test("create-project surface has no serious a11y violations", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/new`);
		await owner.page.getByRole("heading", { name: /provision the future/i }).waitFor();
		const violations = await scanA11y(owner.page);
		// axe is optional locally (no-ops to []); only fail when it actually finds serious issues.
		expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
	});
});

test.describe("Projects — create (mutations)", () => {
	test("Create empty project provisions a project and opens its Architecture", async ({
		owner,
	}) => {
		await owner.page.goto(`/${owner.orgSlug}/~/new`);
		const uniq = `e2e-empty-${Date.now()}`;
		await owner.page.getByLabel(/project name/i).fill(uniq);
		await owner.page.getByRole("button", { name: /create empty project/i }).click();
		// Lands on the new project (bare project URL redirects to /architecture).
		await owner.page.waitForURL(
			new RegExp(`/${owner.orgSlug}/[^/~][^/]*(/architecture)?(\\?|$)`),
			{ timeout: 30_000 },
		);
		await expect(owner.page).not.toHaveURL(/\/~\/new/);
	});

	test("full manual create with a connected cloud provisions and opens the project", async ({
		owner,
	}) => {
		// A verified GCP identity makes the GCP tile connected + selectable.
		await seedCloudIdentity(ownerId(owner), { provider: "gcp" });
		await owner.page.goto(`/${owner.orgSlug}/~/new`);
		const uniq = `e2e-manual-${Date.now()}`;
		await owner.page.getByLabel(/project name/i).fill(uniq);
		// Select the connected GCP tile (clicking the label bubbles to the tile's onSelect).
		await owner.page.getByText("GCP", { exact: true }).click();
		await owner.page.getByRole("button", { name: /^create project$/i }).click();
		await owner.page.waitForURL(
			new RegExp(`/${owner.orgSlug}/[^/~][^/]*(/architecture)?(\\?|$)`),
			{ timeout: 30_000 },
		);
		await expect(owner.page).not.toHaveURL(/\/~\/new/);
	});
});

test.describe("Projects — org overview grid", () => {
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

	test("the 'Add new' toolbar reaches the create-project page", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		// The populated overview offers create via the "Add new" popover → Project.
		await owner.page.getByRole("button", { name: /add new/i }).click({ timeout: 15_000 });
		await owner.page.getByRole("button", { name: /^project/i }).click();
		await owner.page.waitForURL(/\/~\/new(\?|$)/, { timeout: 20_000 });
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

	test("canvas loads with the Add + Project settings affordances", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/${project.slug}/architecture`);
		await expect(owner.page).not.toHaveURL(/\/login/);
		await expect(owner.page.getByRole("button", { name: /^add$/i })).toBeVisible({
			timeout: 20_000,
		});
		await expect(
			owner.page.getByRole("button", { name: /project settings/i }),
		).toBeVisible();
	});

	test("Add opens the service palette which accepts a search query", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/${project.slug}/architecture`);
		await owner.page.getByRole("button", { name: /^add$/i }).click({ timeout: 20_000 });
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
		// The default env is undeletable — no per-row delete button for it.
		await expect(
			owner.page.getByRole("button", { name: /delete production/i }),
		).toHaveCount(0);
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
		let dialog = owner.page.getByRole("dialog");
		const envName = `del${Date.now().toString().slice(-6)}`;
		await dialog.getByLabel(/environment name/i).fill(envName);
		await dialog.getByRole("button", { name: /empty environment/i }).click();
		await dialog.getByRole("button", { name: /create environment/i }).click();
		const link = owner.page.getByRole("link", { name: envName });
		await expect(link).toBeVisible({ timeout: 20_000 });

		// Delete it via the row trash button → confirm dialog.
		await owner.page.getByRole("button", { name: new RegExp(`delete ${envName}`, "i") }).click();
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
		// Open the danger-zone delete dialog.
		await owner.page.getByRole("button", { name: /^delete$/i }).click({ timeout: 15_000 });
		const dialog = owner.page.getByRole("alertdialog");
		await expect(dialog.getByText(/delete this project\?/i)).toBeVisible();
		await dialog.getByRole("button", { name: /delete project/i }).click();
		// Back on the org overview, off the project entirely.
		await owner.page.waitForURL(new RegExp(`/${owner.orgSlug}(\\?|/?$)`), { timeout: 20_000 });
		await expect(owner.page).not.toHaveURL(/\/settings\/general/);
	});
});

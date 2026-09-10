// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Deploy-jobs domain — happy paths, rewritten against today's console (#4274).
//
// FOUR THINGS THIS FILE MEASURES, in the order the issue puts them:
//   1. one seeded finished deploy reaching every surface that should show it — the org overview,
//      the org jobs list, the project's clusters grid, and the evidence roll-up;
//   2. the org jobs list ON THE FILTER STANDARD — all six selections (`search, authors, envs,
//      projects, statuses, types`), both halves of it (the URL hydrates the bar; the bar rewrites
//      the URL), and the property that makes the bar un-un-selectable: facet counts come from the
//      UNFILTERED universe;
//   3. the job detail page RENDERING — status, outcome, facts, logs, and the actions a terminal or
//      in-flight job offers;
//   4. environments: drift, the default tag, auto-heal, and the promotion gates behind Edit rules.
//
// WHAT IS DELIBERATELY NOT HERE, because a test that is silently someone else's is worse than none:
//   · **Cancelling a job.** `destructive-actions.yaml` records `jobs.cancel` as `confirm: none`,
//     `status: missing`, `issue: #4288` — the lane that puts a ConfirmDialog in front of it flips
//     that entry and owns the flow. Driving the mutation here would go red the moment #4288 lands,
//     from a file that has no business knowing about the dialog. The Cancel BUTTON's presence is
//     measured; the click is not.
//   · **Re-running a job.** `rerunJob` inserts a real QUEUED job into the shared persona org, and
//     the QA env runs a live runner that claims QUEUED DEPLOY jobs within seconds. The assertion
//     that used to live here ("navigate to a DIFFERENT job id") therefore raced a runner and was a
//     recorded failure; AUTHORING.md's rule is to stop at QUEUED or seed the post-state, and there
//     is no way to do either while also proving the navigation. The Re-run button's presence is
//     measured; the click is not.
//
// The persona org is SHARED across specs (parallel run), so every assertion is scoped to a
// uniquely-named project we seed here — never "the org is empty". Scoping is done through the
// surfaces' own search params (`?q=` on the overview, `?search=` on jobs and evidence), which is
// both deterministic under sibling writes and a real exercise of the filter standard's URL half. We
// do NOT call cleanupOrg (it would wipe sibling agents' data); seeded rows are uniquely named and
// harmless to leave behind.

import { test, expect } from "../fixtures/qa";
import type { Owner } from "../helpers/seed";
import {
	seedCloudIdentity,
	seedDrift,
	seedFinishedDeploy,
	seedJob,
	seedProject,
	type SeededProject,
} from "../helpers/seed";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** The endpoints `seedFinishedDeploy` stamps onto the cluster row — asserted, not re-derived. */
const CLUSTER_ENDPOINT = "https://e2e.eks.eu-central-1.amazonaws.com";
const ARGOCD_URL = "https://argocd.e2e.example.com";

/**
 * Navigate without waiting for the full `load` event. The QA dev server SSR is slow under parallel
 * load, and job-detail keeps an SSE log stream open, so `load` can outlast the test timeout — DOM
 * content is enough for our assertions (which each have their own visibility timeout).
 */
async function visit(page: import("@playwright/test").Page, path: string) {
	await page.goto(path, { waitUntil: "domcontentloaded" });
}

// Shared preconditions seeded once for the owner (Hobby) persona.
let ownerId: Owner;
let deployed: SeededProject; // ACTIVE project with a finished deploy + drift + several jobs
let successJobId: string;
let failedJobId: string;

test.beforeAll(async () => {
	// The fixtures aren't available in beforeAll, so read the persona record the fixture uses.
	const fs = await import("node:fs");
	const path = await import("node:path");
	const meta = JSON.parse(
		fs.readFileSync(path.resolve(process.cwd(), "e2e/.auth/personas.json"), "utf8"),
	);
	ownerId = { userId: meta.ownerHobby.userId, orgId: meta.ownerHobby.orgId };

	const identity = await seedCloudIdentity(ownerId, { provider: "aws" });

	deployed = await seedProject(ownerId, {
		name: `e2e-deployjobs-active-${Date.now()}`,
		cloudIdentityId: identity.id,
		status: "ACTIVE",
	});
	await seedFinishedDeploy(deployed);
	await seedDrift(deployed, { inSync: false, drifted: 2 });

	// A spread of jobs on the deployed project so both lists + detail have data.
	successJobId = (
		await seedJob(ownerId, {
			jobType: "DEPLOY",
			status: "SUCCESS",
			projectId: deployed.projectId,
			envId: deployed.envId,
			cloudIdentityId: identity.id,
		})
	).id;
	failedJobId = (
		await seedJob(ownerId, {
			jobType: "DEPLOY",
			status: "FAILED",
			projectId: deployed.projectId,
			envId: deployed.envId,
			cloudIdentityId: identity.id,
			errorMessage: "tofu apply failed: InvalidParameterException",
		})
	).id;
});

// The QA dev server SSR is slow under parallel load, and Next compiles each route on first hit
// (cold navs seen at 1.5m+ under 7-agent contention); give each test generous headroom.
test.beforeEach(() => {
	test.setTimeout(180_000);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 1 · One finished deploy, four surfaces.
//
// The same seeded project is looked for on every surface that claims to show deployed
// infrastructure. A surface that renders its own empty state while three others show the project is
// the defect this describe exists to catch — and it is invisible to any per-surface smoke, because
// each one is individually "working".
// ─────────────────────────────────────────────────────────────────────────────────────────────────

test.describe("Deploy jobs — a finished deploy reaches every surface", () => {
	test("the org overview lists the deployed project", async ({ owner }) => {
		// `?q=` is the overview grid's own server-side search — the only way to name one project in
		// an org that sibling specs are writing into throughout the run.
		await visit(owner.page, `/${owner.orgSlug}?q=${encodeURIComponent(deployed.name)}`);
		await expect(owner.page).not.toHaveURL(/\/login/);
		await expect(
			owner.page.getByRole("heading", { name: /^Projects/ }),
		).toBeVisible({ timeout: 25_000 });
		await expect(owner.page.getByText(deployed.name).first()).toBeVisible({ timeout: 15_000 });
	});

	test("the org jobs list carries the project's Deploy jobs", async ({ owner }) => {
		await visit(
			owner.page,
			`/${owner.orgSlug}/~/jobs?search=${encodeURIComponent(deployed.name)}`,
		);
		await expect(owner.page).not.toHaveURL(/\/login/);
		// Two seeded jobs on this project (one SUCCESS, one FAILED) and nothing else matches the
		// unique project name, so the count is a real statement rather than "at least one row".
		const rows = owner.page.getByRole("row").filter({ hasText: deployed.name });
		await expect(rows).toHaveCount(2, { timeout: 25_000 });
		// The Type cell carries the label AND its description, so this is a containment check on
		// the row rather than an exact cell name.
		await expect(rows.first()).toContainText("Deploy");
	});

	test("the project's clusters page names the cluster and its endpoint", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/${deployed.slug}/clusters`);
		// The card's heading is the project name (`SectionHeading level={3}`); there is no page
		// title on this surface and asserting one is what made the old test fail.
		await expect(
			owner.page.getByRole("heading", { name: deployed.name }),
		).toBeVisible({ timeout: 25_000 });
		await expect(owner.page.getByText(CLUSTER_ENDPOINT)).toBeVisible();
		await expect(
			owner.page.getByRole("button", { name: "Copy cluster endpoint" }),
		).toBeVisible();
	});

	test("the cluster card offers ArgoCD and its password recipe", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/${deployed.slug}/clusters`);
		await expect(owner.page.getByText(ARGOCD_URL)).toBeVisible({ timeout: 25_000 });
		await expect(owner.page.getByRole("button", { name: "Open ArgoCD" })).toBeVisible();
		// The admin password is never stored, so the card hands over the command instead — the
		// distinction is the whole reason this block exists.
		await expect(
			owner.page.getByRole("button", { name: "Copy ArgoCD admin password command" }),
		).toBeVisible();
	});

	test("the org clusters grid shows the same cluster", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/~/clusters`);
		await expect(owner.page).not.toHaveURL(/\/login/);
		await expect(
			owner.page.getByRole("heading", { name: deployed.name }),
		).toBeVisible({ timeout: 25_000 });
	});

	test("evidence rolls the environment up with its drift count", async ({ owner }) => {
		await visit(
			owner.page,
			`/${owner.orgSlug}/~/evidence?search=${encodeURIComponent(deployed.name)}`,
		);
		await expect(owner.page).not.toHaveURL(/\/login/);
		await expect(
			owner.page.getByRole("heading", { name: /^Environments/ }),
		).toBeVisible({ timeout: 25_000 });
		// The project is a row GROUP; its one environment is the row inside it.
		await expect(owner.page.getByText(deployed.name).first()).toBeVisible();
		await expect(
			owner.page.getByRole("button", { name: "production", exact: true }),
		).toBeVisible();
		// `seedDrift` wrote `drifted: 2`, and `driftMark` renders exactly that number — so this
		// asserts the seeded fact reached the roll-up, not merely that a drift column exists.
		await expect(owner.page.getByText("2 drifted")).toBeVisible();
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 2 · The org jobs list on the console filter standard.
//
// `jobs-client.tsx` runs `useFilterUrlSync(useJobsFilters, DEFAULT_JOBS_FILTERS)` with no param
// renaming, so each selection's URL param IS its store key: `search`, `authors`, `envs`, `projects`,
// `statuses`, `types`. That is what lets the URL half be driven from a `goto` instead of six
// combobox interactions — and what makes a param rename a test failure rather than a silent
// un-shareable link.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

test.describe("Deploy jobs — the org jobs list on the filter standard", () => {
	test("all six filter selections render", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/~/jobs`);
		await expect(owner.page).not.toHaveURL(/\/login/);
		// `MultiCombobox` surfaces its label as the input's PLACEHOLDER (the input is the trigger),
		// so the facets have no visible text of their own to match on.
		await expect(owner.page.getByLabel("Search jobs")).toBeVisible({ timeout: 25_000 });
		for (const facet of [
			"All authors",
			"All environments",
			"All projects",
			"All statuses",
			"All types",
		]) {
			await expect(owner.page.getByPlaceholder(facet), `${facet} facet`).toBeVisible();
		}
	});

	test("a URL-borne filter hydrates the bar and scopes the rows", async ({ owner }) => {
		await visit(
			owner.page,
			`/${owner.orgSlug}/~/jobs?search=${encodeURIComponent(deployed.name)}&statuses=FAILED`,
		);
		// Two active selections → the Reset affordance appears and counts them. This is the bar
		// reading the URL; a link that filtered the rows but left the bar pristine would be
		// un-clearable and would tell the user the list is unfiltered.
		await expect(owner.page.getByRole("button", { name: "Reset · 2" })).toBeVisible({
			timeout: 25_000,
		});
		// One of this project's two jobs is FAILED.
		await expect(
			owner.page.getByRole("row").filter({ hasText: deployed.name }),
		).toHaveCount(1);
	});

	test("choosing a facet option writes it back to the URL", async ({ owner }) => {
		await visit(
			owner.page,
			`/${owner.orgSlug}/~/jobs?search=${encodeURIComponent(deployed.name)}`,
		);
		await expect(
			owner.page.getByRole("row").filter({ hasText: deployed.name }),
		).toHaveCount(2, { timeout: 25_000 });
		// The input IS the trigger — focusing it opens the list.
		await owner.page.getByPlaceholder("All statuses").click();
		await owner.page.getByRole("button", { name: /^Failed/ }).click();
		await expect(owner.page).toHaveURL(/[?&]statuses=FAILED\b/);
		await expect(
			owner.page.getByRole("row").filter({ hasText: deployed.name }),
		).toHaveCount(1);
	});

	test("facet counts come from the unfiltered universe", async ({ owner }) => {
		// The rule the console filter standard exists to protect: a facet's options are counted over
		// the scope, NOT over the current filter. Filter in memory and the option you just picked
		// vanishes from its own list, which makes the bar impossible to un-select.
		await visit(
			owner.page,
			`/${owner.orgSlug}/~/jobs?search=${encodeURIComponent(deployed.name)}`,
		);
		await expect(
			owner.page.getByRole("row").filter({ hasText: deployed.name }),
		).toHaveCount(2, { timeout: 25_000 });
		await owner.page.getByPlaceholder("All statuses").click();
		// An option click `preventDefault`s its mousedown to keep focus in the input, so the list
		// stays open — which is what lets the SAME list be re-read after the selection lands.
		await owner.page.getByRole("button", { name: /^Failed/ }).click();
		await expect(
			owner.page.getByRole("row").filter({ hasText: deployed.name }),
		).toHaveCount(1);
		// Both are still offered even though the rows are now one status: the one just selected,
		// and one the current filter excludes entirely.
		await expect(owner.page.getByRole("button", { name: /^Failed/ })).toBeVisible();
		await expect(owner.page.getByRole("button", { name: /^Success/ })).toBeVisible();
	});

	test("a filter that matches nothing says so, and never says 'No jobs yet'", async ({ owner }) => {
		await visit(
			owner.page,
			`/${owner.orgSlug}/~/jobs?search=e2e-no-such-project-${Date.now()}`,
		);
		await expect(owner.page.getByText("No jobs match these filters")).toBeVisible({
			timeout: 25_000,
		});
		// `total` is the count over the UNFILTERED universe, so the onboarding copy here would tell
		// an org with a year of history that it has never run a job.
		await expect(owner.page.getByText("No jobs yet")).toHaveCount(0);
	});

	test("the project-scoped list pins the project and drops its facet", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/${deployed.slug}/jobs`);
		await expect(owner.page).not.toHaveURL(/\/login/);
		await expect(
			owner.page.getByRole("row").filter({ hasText: "Deploy" }).first(),
		).toBeVisible({ timeout: 25_000 });
		// `projectId` overrides the Project selection server-side, so offering the facet would be
		// offering a control that cannot change the result.
		await expect(owner.page.getByPlaceholder("All projects")).toHaveCount(0);
		await expect(owner.page.getByPlaceholder("All statuses")).toBeVisible();
	});

	test("clicking a job row opens its detail page", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/${deployed.slug}/jobs`);
		const row = owner.page.getByRole("row").filter({ hasText: "Deploy" }).first();
		await expect(row).toBeVisible({ timeout: 25_000 });
		await row.click();
		await owner.page.waitForURL(new RegExp(`/~/jobs/${UUID_RE.source}`), { timeout: 20_000 });
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 3 · The job detail page renders.
//
// There is NO page title here and asserting one is what the old file did: the breadcrumb already
// resolves the job's uuid to its type label, so `PageToolbar` carries only the live state and the
// actions. What the page owes a reader is the outcome, the facts, the log, and the one action its
// status makes available — those are what is measured.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

test.describe("Deploy jobs — the job detail page", () => {
	test("a SUCCESS deploy renders its outcome and its short id", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/~/jobs/${successJobId}`);
		await expect(owner.page.getByText("Job completed successfully.")).toBeVisible({
			timeout: 25_000,
		});
		// The toolbar's mono id — the anchor that says this is THAT job, not merely a job page.
		await expect(owner.page.getByText(successJobId.slice(0, 8), { exact: true })).toBeVisible();
	});

	test("the Job details disclosure reveals the full job id", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/~/jobs/${successJobId}`);
		// The trigger lives INSIDE the `SectionHeading`, so the page has both a heading in the
		// outline and a control that says whether it is open.
		const trigger = owner.page.getByRole("button", { name: /Job details/i });
		await expect(trigger).toBeVisible({ timeout: 25_000 });
		await trigger.click();
		await expect(owner.page.getByText(successJobId, { exact: true })).toBeVisible();
	});

	test("a FAILED deploy shows the failure banner and its error message", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/~/jobs/${failedJobId}`);
		await expect(owner.page.getByText("Job failed")).toBeVisible({ timeout: 25_000 });
		await expect(
			owner.page.getByText(/tofu apply failed: InvalidParameterException/),
		).toBeVisible();
	});

	test("a terminal job offers Re-run", async ({ owner }) => {
		// Presence only — see this file's header for why the click is #4288-adjacent runner work.
		await visit(owner.page, `/${owner.orgSlug}/~/jobs/${successJobId}`);
		await expect(owner.page.getByRole("button", { name: /re-?run/i })).toBeEnabled({
			timeout: 25_000,
		});
		// A finished job has nothing to cancel.
		await expect(owner.page.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
	});

	test("a job with no log chunks renders the logs empty state", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/~/jobs/${successJobId}`);
		await expect(owner.page.getByText("No logs recorded for this job.")).toBeVisible({
			timeout: 25_000,
		});
	});

	// The QA env runs a live runner that claims real QUEUED DEPLOY jobs within seconds (they then
	// fail preflight on a missing local tool), so a seeded QUEUED job will not persist. PROCESSING
	// is the in-flight state the runner does NOT claim, which is what makes this deterministic.
	test("an in-flight job offers Cancel and the waiting-for-runner state", async ({ owner }) => {
		const { id } = await seedJob(ownerId, {
			jobType: "DEPLOY",
			status: "PROCESSING",
			projectId: deployed.projectId,
			envId: deployed.envId,
		});
		await visit(owner.page, `/${owner.orgSlug}/~/jobs/${id}`);
		// The BUTTON, not the mutation: `destructive-actions.yaml` has `jobs.cancel` as
		// `status: missing` behind #4288, and that lane owns what happens after the click.
		await expect(owner.page.getByRole("button", { name: "Cancel", exact: true })).toBeEnabled({
			timeout: 25_000,
		});
		await expect(owner.page.getByText(/Waiting for runner to claim job/i)).toBeVisible();
		// An in-flight job has nothing to re-run.
		await expect(owner.page.getByRole("button", { name: /re-?run/i })).toHaveCount(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 4 · Environments — drift, the default environment, and the promotion gates.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

test.describe("Deploy jobs — environments, drift and promotion gates", () => {
	test("the environments view heads its list and names the default environment", async ({
		owner,
	}) => {
		await visit(owner.page, `/${owner.orgSlug}/${deployed.slug}/environments`);
		await expect(owner.page).not.toHaveURL(/\/login/);
		// The heading carries a count pill, so the name is a prefix match, not an equality.
		await expect(
			owner.page.getByRole("heading", { name: /^Environments/ }),
		).toBeVisible({ timeout: 25_000 });
		await expect(owner.page.getByRole("link", { name: "production" })).toBeVisible();
	});

	test("a drifted environment is badged and says what drifted means", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/${deployed.slug}/environments`);
		// "Drifted", not "Drift" — the badge and the evidence column word this differently, and the
		// old assertion was pinned to the evidence page's noun on the environments page's badge.
		await expect(owner.page.getByText("Drifted", { exact: true })).toBeVisible({
			timeout: 25_000,
		});
		await expect(owner.page.getByText("Diverged from provisioned state")).toBeVisible();
	});

	test("the default environment carries its tag and an auto-heal switch", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/${deployed.slug}/environments`);
		await expect(owner.page.getByText("Default", { exact: true })).toBeVisible({
			timeout: 25_000,
		});
		await expect(
			owner.page.getByRole("switch", { name: "Toggle auto-heal for production" }),
		).toBeVisible();
	});

	test("New Environment opens its dialog", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/${deployed.slug}/environments`);
		await owner.page.getByRole("button", { name: /New Environment/i }).click();
		const dialog = owner.page.getByRole("dialog");
		await expect(dialog).toBeVisible({ timeout: 15_000 });
		await expect(dialog.getByLabel("Environment name")).toBeVisible();
	});

	test("Edit rules opens the protection sheet with its three gates", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/${deployed.slug}/environments`);
		// The trigger is the "Edit rules" link beside "Gates into this env" — the old assertion
		// looked for a `Protection rules for production` button, which this surface has never had.
		await owner.page.getByRole("button", { name: "Edit rules" }).click();
		const sheet = owner.page.getByRole("dialog");
		await expect(sheet).toBeVisible({ timeout: 15_000 });
		await expect(sheet.getByText("Require predecessor")).toBeVisible();
		await expect(sheet.getByText("Require verify pass")).toBeVisible();
		await expect(sheet.getByText("Require approval")).toBeVisible();
	});
});

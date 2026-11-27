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
//   · **Cancelling a job.** #4288 has LANDED — `destructive-actions.yaml` now records `jobs.cancel`
//     as `confirm: confirm-dialog`, `dialog_title: "Cancel this job?"`, `status: confirmed`. That
//     registry is the single record of what stands between the click and the mutation, and it is
//     `scripts/check-destructive-actions.mjs` and `audit/destructive.spec.ts` that hold the code to
//     it. Driving the click here would be a second, weaker copy of a flow that registry owns, kept
//     in step by hand with a dialog this file has no business knowing about. The Cancel BUTTON's
//     presence is what this file measures; the click is not.
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

import type { Page } from "@playwright/test";
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
		// The clusters are a table since #6819, one row per cluster and led by the ENVIRONMENT; the
		// row's first cell is the control that opens the cluster's record, where the endpoint is.
		const open = owner.page.getByRole("button", { name: `Open production in ${deployed.name}` });
		await expect(open).toBeVisible({ timeout: 25_000 });
		await open.click();
		const record = owner.page.getByRole("dialog");
		await expect(record).toBeVisible({ timeout: 15_000 });
		await expect(record.getByText(CLUSTER_ENDPOINT, { exact: true })).toBeVisible();
		await expect(record.getByRole("button", { name: "Copy cluster endpoint" })).toBeVisible();
		// The open row is in the URL, so the record is a link.
		await expect(owner.page).toHaveURL(/[?&]selected=/);
	});

	// The titles of this test and the next still say "card" and "grid": a title is the key of its
	// entry in gate-baseline.json, which is generated and never hand-edited. What each ASSERTS is
	// the table and the record (#6819).
	test("the cluster card offers ArgoCD and its password recipe", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/${deployed.slug}/clusters`);
		const open = owner.page.getByRole("button", { name: `Open production in ${deployed.name}` });
		await expect(open).toBeVisible({ timeout: 25_000 });
		await open.click();
		const record = owner.page.getByRole("dialog");
		await expect(record.getByText(ARGOCD_URL, { exact: true })).toBeVisible({ timeout: 15_000 });
		// One link, not a button nested in an anchor (#6819).
		await expect(record.getByRole("link", { name: "Open ArgoCD in a new tab" })).toHaveAttribute(
			"href",
			ARGOCD_URL,
		);
		// The admin password is never stored, so the record hands over the command instead — the
		// distinction is the whole reason this block exists.
		await expect(
			record.getByRole("button", { name: "Copy ArgoCD admin password command" }),
		).toBeVisible();
	});

	test("the org clusters grid shows the same cluster", async ({ owner }) => {
		// The org list is paged and the persona org is shared, so the list's own `?search=` names the
		// one project; the URL hydrating the bar is the filter standard's URL half.
		await visit(
			owner.page,
			`/${owner.orgSlug}/~/clusters?search=${encodeURIComponent(deployed.name)}`,
		);
		await expect(owner.page).not.toHaveURL(/\/login/);
		// The org list has a Project column the project's own list does not; the row is still led by
		// the environment.
		await expect(
			owner.page.getByRole("button", { name: `Open production in ${deployed.name}` }),
		).toBeVisible({ timeout: 25_000 });
		await expect(owner.page.getByRole("columnheader", { name: "Project" })).toBeVisible();
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

/**
 * A toolbar facet's button by its accessible name — `Status` idle, `Status: Failed` selected, or the
 * sibling `Clear Status`. Scoped to the `FacetFilter` boxes, because the jobs table's column headers
 * carry the same words.
 */
function facetTrigger(page: Page, name: string) {
	return page.locator('[data-slot="facet-filter"]').getByRole("button", { name, exact: true });
}

test.describe("Deploy jobs — the org jobs list on the filter standard", () => {
	test("all six filter selections render", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/~/jobs`);
		await expect(owner.page).not.toHaveURL(/\/login/);
		// Each facet is a `FacetFilter` button named for its facet while nothing is selected
		// (`Name ▾`, polish-wave spec §3) — so each is asked for BY ROLE under that name. Never
		// `getByPlaceholder`/`getByLabel` on a filter-bar input: they match the server's hidden
		// streamed copy of the bar too (#5777, #5800; scripts/ci/check-e2e-filter-locators.mjs).
		await expect(owner.page.getByRole("textbox", { name: "Search jobs", exact: true })).toBeVisible({ timeout: 25_000 });
		for (const facet of ["Author", "Environment", "Project", "Status", "Type"]) {
			await expect(facetTrigger(owner.page, facet), `${facet} facet`).toBeVisible();
		}
		// One row, no description line (#7738).
		await expect(owner.page.locator('[data-slot="page-toolbar"]')).toHaveCount(0);
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
		// The facet names what the link selected, and carries its own clear.
		await expect(facetTrigger(owner.page, "Status: Failed")).toBeVisible();
		await expect(facetTrigger(owner.page, "Clear Status")).toBeVisible();
		// One of this project's two jobs is FAILED.
		//
		// 25s, LIKE EVERY OTHER ASSERTION IN THIS FILE, and this is the one that needs it most.
		// `useFilterUrlSync` hydrates the store AFTER mount, so the first query goes out with
		// `search: ""` and paints the org-wide first page — which already holds this project's two
		// rows, since they were just seeded. The "before" state is therefore exactly 2, and this
		// cannot reach 1 until the hydrated `search` clears `useDebouncedValue(filters.search, 300)`,
		// re-keys the query, round-trips and re-renders. On the default 5s, on a 3-worker runner
		// this file elsewhere describes as taking 1.5 min for a cold nav, that is a coin flip.
		await expect(
			owner.page.getByRole("row").filter({ hasText: deployed.name }),
		).toHaveCount(1, { timeout: 25_000 });
	});

	test("choosing a facet option writes it back to the URL", async ({ owner }) => {
		await visit(
			owner.page,
			`/${owner.orgSlug}/~/jobs?search=${encodeURIComponent(deployed.name)}`,
		);
		await expect(
			owner.page.getByRole("row").filter({ hasText: deployed.name }),
		).toHaveCount(2, { timeout: 25_000 });
		// The facet's button opens its option list.
		await facetTrigger(owner.page, "Status").click();
		await owner.page.getByRole("option", { name: /^Failed/ }).click();
		await expect(owner.page).toHaveURL(/[?&]statuses=FAILED\b/);
		// The URL is written synchronously; the ROWS are a debounce plus a refetch behind it, so
		// this waits as long as its siblings rather than on the default 5s.
		await expect(
			owner.page.getByRole("row").filter({ hasText: deployed.name }),
		).toHaveCount(1, { timeout: 25_000 });
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
		await facetTrigger(owner.page, "Status").click();
		// Toggling an option keeps the popover open — which is what lets the SAME list be re-read
		// after the selection lands.
		await owner.page.getByRole("option", { name: /^Failed/ }).click();
		// Same debounce + refetch as its sibling above, so the same 25s.
		await expect(
			owner.page.getByRole("row").filter({ hasText: deployed.name }),
		).toHaveCount(1, { timeout: 25_000 });
		// Both are still offered even though the rows are now one status: the one just selected,
		// and one the current filter excludes entirely.
		await expect(owner.page.getByRole("option", { name: /^Failed/ })).toBeVisible();
		await expect(owner.page.getByRole("option", { name: /^Success/ })).toBeVisible();
	});

	test("a filter that matches nothing says so, and never says 'No jobs yet'", async ({ owner }) => {
		await visit(
			owner.page,
			`/${owner.orgSlug}/~/jobs?search=e2e-no-such-project-${Date.now()}`,
		);
		// THIS ONE ASSERTION IS THE WHOLE TEST, and it is the one that bites. `jobs-client.tsx` picks
		// its empty state with `total === 0 ? "No jobs yet" : noMatch`, where `total` is the count
		// over the UNFILTERED universe — the onboarding copy would otherwise tell an org with a
		// year of history that it has never run a job. The org here HAS jobs and the filter matches
		// none of them, which is exactly the state that separates the two branches: a `total`
		// computed over the filtered rows renders "No jobs yet" and this `toBeVisible` times out.
		//
		// The line removed from under it — `expect(getByText("No jobs yet")).toHaveCount(0)` —
		// asserted the other branch's copy from inside this one. The two are mutually exclusive
		// arms of a single ternary, so it was implied by the assertion above and had no failing
		// input of its own.
		await expect(owner.page.getByText("No jobs match these filters.", { exact: true })).toBeVisible({
			timeout: 25_000,
		});
	});

	test("the project-scoped list pins the project and drops its facet", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/${deployed.slug}/jobs`);
		await expect(owner.page).not.toHaveURL(/\/login/);
		await expect(
			owner.page.getByRole("row").filter({ hasText: "Deploy" }).first(),
		).toBeVisible({ timeout: 25_000 });
		// `projectId` overrides the Project selection server-side, so offering the facet would be
		// offering a control that cannot change the result.
		await expect(facetTrigger(owner.page, "Project")).toHaveCount(0);
		await expect(facetTrigger(owner.page, "Status")).toBeVisible();
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
		// Presence only. The reason is the live runner, NOT #4288 — see this file's header: `rerunJob`
		// inserts a real QUEUED job that the QA runner claims within seconds, so the post-click state
		// cannot be asserted without racing it.
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
	//
	// THE TITLE STILL SAYS "waiting-for-runner" AND THE BODY NO LONGER ASSERTS IT (#6818). The title
	// is this test's key in `e2e/gate-baseline.json`, which another open unit holds, so it is left as
	// it is: what the test measures is what the log pane says for an in-flight job with no output.
	test("an in-flight job offers Cancel and the waiting-for-runner state", async ({ owner }) => {
		const { id } = await seedJob(ownerId, {
			jobType: "DEPLOY",
			status: "PROCESSING",
			projectId: deployed.projectId,
			envId: deployed.envId,
		});
		await visit(owner.page, `/${owner.orgSlug}/~/jobs/${id}`);
		// The BUTTON, not the mutation: `jobs.cancel` is `confirm: confirm-dialog`, `status: confirmed`
		// in `destructive-actions.yaml` since #4288 landed, and that registry and its checks own what
		// happens after the click. This file measures that the control is offered at all.
		await expect(owner.page.getByRole("button", { name: "Cancel", exact: true })).toBeEnabled({
			timeout: 25_000,
		});
		// A PROCESSING job HAS a runner, so the log pane says it is running and has printed nothing
		// yet. It used to say "Waiting for runner to claim job" for every in-flight status, which is
		// what this line asserted until #6818 — the sentence was false for exactly this job.
		await expect(owner.page.getByText("Running — no output yet")).toBeVisible();
		await expect(owner.page.getByText(/waiting for a runner/i)).toHaveCount(0);
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
		// The list is headed by its one-row toolbar (search, facets, and the actions on the right), not
		// an in-content title: #6120 removed the "Environments N" heading (F010) — the breadcrumb names
		// the page — and #7738 removed the page toolbar's description line with the toolbar itself.
		await expect(owner.page.locator('[data-slot="list-toolbar-end"]')).toBeVisible({ timeout: 25_000 });
		await expect(owner.page.locator('[data-slot="page-toolbar"]')).toHaveCount(0);
		await expect(owner.page.getByRole("heading", { name: /^Environments/ })).toHaveCount(0);
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

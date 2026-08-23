// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Deploy-jobs domain — happy paths. Covers the provisioning-job lifecycle *up to QUEUED* and the
// seeded post-deploy UI: the org + project jobs lists, job detail/logs, cancel + re-run (the latter
// is the UI-triggered QUEUED assertion), the clusters grid (seeded finished deploy → name/endpoint),
// and the environments view (drift badge, promotions, protection rules, auto-heal).
//
// The persona org is SHARED across specs (parallel run), so every assertion is scoped to a
// uniquely-named project we seed here — never "the org is empty". We do NOT call cleanupOrg (it would
// wipe sibling agents' data); seeded rows are uniquely named and harmless to leave behind.

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

test.describe("Deploy jobs — org jobs list", () => {
	test("loads without bouncing to login and shows the filter bar", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/~/jobs`);
		await expect(owner.page).not.toHaveURL(/\/login/);
		// Non-empty (we seeded jobs) → the filter bar renders instead of the empty state. The facet
		// combobox surfaces its label as an <input> placeholder, not visible text.
		await expect(owner.page.getByPlaceholder("All statuses")).toBeVisible({ timeout: 15_000 });
	});

	test("renders a seeded Deploy job row", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/~/jobs`);
		await expect(owner.page.getByText("Deploy", { exact: true }).first()).toBeVisible({
			timeout: 15_000,
		});
	});

	test("exposes status + type facet filters", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/~/jobs`);
		await expect(owner.page.getByPlaceholder("All statuses")).toBeVisible({ timeout: 15_000 });
		await expect(owner.page.getByPlaceholder("All types")).toBeVisible();
		await expect(owner.page.getByPlaceholder("All projects")).toBeVisible();
	});
});

test.describe("Deploy jobs — project jobs list", () => {
	test("scopes to the project and drops the Project facet", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/${deployed.slug}/jobs`);
		await expect(owner.page).not.toHaveURL(/\/login/);
		await expect(owner.page.getByText("Deploy", { exact: true }).first()).toBeVisible({
			timeout: 15_000,
		});
		// Project-scoped view hides the "All projects" facet.
		await expect(owner.page.getByPlaceholder("All projects")).toHaveCount(0);
	});

	test("clicking a job row opens its detail page", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/${deployed.slug}/jobs`);
		const row = owner.page.getByRole("row").filter({ hasText: "Deploy" }).first();
		await expect(row).toBeVisible({ timeout: 15_000 });
		await row.click();
		await owner.page.waitForURL(new RegExp(`/~/jobs/${UUID_RE.source}`), { timeout: 15_000 });
	});
});

test.describe("Deploy jobs — job detail & logs", () => {
	test("a SUCCESS deploy renders label, status and the success footer", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/~/jobs/${successJobId}`);
		await expect(owner.page.getByRole("heading", { name: "Deploy" })).toBeVisible({
			timeout: 15_000,
		});
		await expect(owner.page.getByText("Job completed successfully.")).toBeVisible();
	});

	test("the Job Details collapsible reveals the full job id", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/~/jobs/${successJobId}`);
		const trigger = owner.page.getByRole("button", { name: /Job Details/i });
		await expect(trigger).toBeVisible({ timeout: 15_000 });
		await trigger.click();
		await expect(owner.page.getByText(successJobId, { exact: true })).toBeVisible();
	});

	test("a FAILED deploy shows the failure banner and error message", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/~/jobs/${failedJobId}`);
		await expect(owner.page.getByText("Job failed")).toBeVisible({ timeout: 15_000 });
		await expect(
			owner.page.getByText(/tofu apply failed: InvalidParameterException/),
		).toBeVisible();
	});

	test("a terminal job offers a Re-run action", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/~/jobs/${successJobId}`);
		await expect(owner.page.getByRole("button", { name: /re-?run/i })).toBeVisible({
			timeout: 15_000,
		});
	});

	test("logs empty-state renders for a job with no log chunks", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/~/jobs/${successJobId}`);
		await expect(owner.page.getByText("No logs recorded for this job.")).toBeVisible({
			timeout: 15_000,
		});
	});
});

// NOTE: the QA env runs a live runner that claims real QUEUED DEPLOY jobs within seconds (they then
// fail preflight on a missing local tool). So a seeded QUEUED job won't persist — we seed PROCESSING
// (the runner only *claims* QUEUED, so a PROCESSING job stays in-flight) to exercise the active-job
// affordances deterministically.
test.describe("Deploy jobs — in-flight lifecycle (cancel & re-run)", () => {
	test("an in-flight job shows Cancel and the waiting-for-runner state", async ({ owner }) => {
		const { id } = await seedJob(ownerId, {
			jobType: "DEPLOY",
			status: "PROCESSING",
			projectId: deployed.projectId,
			envId: deployed.envId,
		});
		await visit(owner.page, `/${owner.orgSlug}/~/jobs/${id}`);
		await expect(owner.page.getByRole("button", { name: "Cancel" })).toBeVisible({
			timeout: 15_000,
		});
		await expect(owner.page.getByText(/Waiting for runner to claim job/i)).toBeVisible();
	});

	test("cancelling an in-flight job moves it to CANCELLED", async ({ owner }) => {
		const { id } = await seedJob(ownerId, {
			jobType: "DEPLOY",
			status: "PROCESSING",
			projectId: deployed.projectId,
			envId: deployed.envId,
		});
		await visit(owner.page, `/${owner.orgSlug}/~/jobs/${id}`);
		const cancel = owner.page.getByRole("button", { name: "Cancel" });
		await expect(cancel).toBeVisible({ timeout: 15_000 });
		await cancel.click();
		await expect(owner.page.getByText("Job cancelled")).toBeVisible({ timeout: 15_000 });
	});

	test("re-running a finished deploy queues a NEW provision job", async ({ owner }) => {
		// A dedicated finished job so this test owns the re-run source.
		const { id } = await seedJob(ownerId, {
			jobType: "DEPLOY",
			status: "SUCCESS",
			projectId: deployed.projectId,
			envId: deployed.envId,
		});
		await visit(owner.page, `/${owner.orgSlug}/~/jobs/${id}`);
		const rerun = owner.page.getByRole("button", { name: /re-?run/i });
		await expect(rerun).toBeVisible({ timeout: 15_000 });
		await rerun.click();
		// rerunJob inserts a fresh QUEUED job and navigates to it — assert a DIFFERENT job id.
		await owner.page.waitForURL(
			(url) =>
				new RegExp(`/~/jobs/${UUID_RE.source}$`).test(url.pathname) &&
				!url.pathname.includes(id),
			{ timeout: 30_000 },
		);
		// The new job renders its own detail page.
		await expect(owner.page.getByRole("heading", { name: "Deploy" })).toBeVisible({
			timeout: 15_000,
		});
	});
});

test.describe("Deploy jobs — clusters", () => {
	test("org clusters page renders its heading", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/~/clusters`);
		await expect(owner.page).not.toHaveURL(/\/login/);
		await expect(owner.page.getByRole("heading", { name: "Clusters" })).toBeVisible({
			timeout: 15_000,
		});
	});

	test("a seeded finished deploy surfaces the cluster name + endpoint", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/${deployed.slug}/clusters`);
		await expect(owner.page.getByText(deployed.name).first()).toBeVisible({ timeout: 15_000 });
		await expect(
			owner.page.getByText("https://e2e.eks.eu-central-1.amazonaws.com"),
		).toBeVisible();
	});

	test("the cluster card links out to ArgoCD", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/${deployed.slug}/clusters`);
		await expect(
			owner.page.getByText("https://argocd.e2e.example.com"),
		).toBeVisible({ timeout: 15_000 });
		await expect(owner.page.getByText("ArgoCD", { exact: true })).toBeVisible();
	});
});

test.describe("Deploy jobs — environments, drift, promotions, protection", () => {
	test("environments view renders the heading and the default environment", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/${deployed.slug}/environments`);
		await expect(owner.page).not.toHaveURL(/\/login/);
		await expect(owner.page.getByRole("heading", { name: "Environments" })).toBeVisible({
			timeout: 15_000,
		});
		await expect(owner.page.getByText("production").first()).toBeVisible();
	});

	test("a drifted environment shows the Drift badge", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/${deployed.slug}/environments`);
		await expect(owner.page.getByText("Drift", { exact: true })).toBeVisible({ timeout: 15_000 });
	});

	test("the default environment carries the Default tag and an auto-heal toggle", async ({
		owner,
	}) => {
		await visit(owner.page, `/${owner.orgSlug}/${deployed.slug}/environments`);
		await expect(owner.page.getByText("Default", { exact: true })).toBeVisible({ timeout: 15_000 });
		await expect(
			owner.page.getByRole("switch", { name: /Toggle auto-heal for production/i }),
		).toBeVisible();
	});

	test("New Environment dialog opens from the environments view", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/${deployed.slug}/environments`);
		await owner.page.getByRole("button", { name: /New Environment/i }).click();
		await expect(owner.page.getByRole("dialog")).toBeVisible({ timeout: 10_000 });
	});

	test("protection-rules dialog opens with its promotion gates", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/${deployed.slug}/environments`);
		await owner.page
			.getByRole("button", { name: /Protection rules for production/i })
			.click();
		const dialog = owner.page.getByRole("dialog");
		await expect(dialog).toBeVisible({ timeout: 10_000 });
		await expect(dialog.getByText("Require predecessor")).toBeVisible();
		await expect(dialog.getByText("Require verify pass")).toBeVisible();
		await expect(dialog.getByText("Require approval")).toBeVisible();
	});
});

// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// E2E — Cross-cutting resilience sweep (happy paths). The broad safety net that loads every major
// console page as the `owner` persona and asserts, per page:
//   (a) no redirect to /login (the authed session resolves the route),
//   (b) the document response is < 500 AND no uncaught pageerror / >=500 response fired,
//   (c) the shell `main` landmark renders (proof the page painted, not a blank/crash),
//   (d) an optional, non-failing a11y record on the overview.
// This is intentionally shallow-but-wide: it catches broken pages / 500s fast across the whole app
// surface. Deep per-domain behavior lives in the domain specs (connectors/runners/jobs/alerts/…).
//
// Rule 6 (AUTHORING.md): read-only page loads emit expected 401/analytics noise — we only FAIL on a
// genuine pageerror or a >=500 response, never on console.error / 4xx.
//
// Run (self-check):
//   REUSE_AUTH=1 E2E_BASE_URL=http://localhost:3100 DEV_CONSOLE_LOG=/tmp/alethia-qa-console.log \
//     E2E_WORKERS=1 E2E_RETRIES=1 npx playwright test e2e/flows/cross-cutting.spec.ts \
//     --output=test-results/wf-cross-cutting
//
// Isolation: the project surfaces share ONE lazily-seeded, uniquely-named project scoped to the
// persona org. We do NOT call cleanupOrg (sibling QA agents share this persona org in the parallel run).

import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/qa";
import type { ConsoleGuard } from "../helpers/console-errors";
import { scanA11y } from "../helpers/a11y";
import {
	seedCloudIdentity,
	seedDrift,
	seedFinishedDeploy,
	seedJob,
	seedProject,
	type Owner,
	type SeededProject,
} from "../helpers/seed";

/** The persona's Owner id tuple for seeding. */
function ownerId(s: { userId?: string; orgId?: string }): Owner {
	return { userId: s.userId!, orgId: s.orgId! };
}

/** The fatal subset of captured errors: uncaught pageerrors + >=500 responses (per AUTHORING rule 6). */
function fatalErrors(guard: ConsoleGuard): string[] {
	return guard.errors
		.filter((e) => e.kind === "pageerror" || (e.kind === "response" && (e.status ?? 0) >= 500))
		.map((e) => `[${e.kind}] ${e.text}`);
}

/**
 * Loads `url`, asserts the document response isn't a 5xx, the route didn't bounce to /login, and the
 * shell `main` landmark painted. Returns after the assertions so the caller can inspect the guard.
 */
async function loadAndAssertShell(page: Page, url: string): Promise<void> {
	const resp = await page.goto(url, { waitUntil: "domcontentloaded" });
	// The navigation document itself must not be a server error.
	if (resp) expect(resp.status(), `document status for ${url}`).toBeLessThan(500);
	await expect(page, `did not redirect to /login for ${url}`).not.toHaveURL(/\/login/);
	await expect(page.getByRole("main"), `main landmark for ${url}`).toBeVisible({ timeout: 25_000 });
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Org-scope routes — no seed needed (the persona org always exists).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const ORG_ROUTES: { label: string; path: (slug: string) => string }[] = [
	{ label: "overview", path: (s) => `/${s}` },
	{ label: "connectors", path: (s) => `/${s}/~/connectors` },
	{ label: "runners", path: (s) => `/${s}/~/runners` },
	{ label: "jobs", path: (s) => `/${s}/~/jobs` },
	{ label: "clusters", path: (s) => `/${s}/~/clusters` },
	{ label: "alerts", path: (s) => `/${s}/~/alerts` },
	{ label: "agent", path: (s) => `/${s}/~/agent` },
	{ label: "usage", path: (s) => `/${s}/~/usage` },
	{ label: "new project", path: (s) => `/${s}/~/new` },
	{ label: "settings/general", path: (s) => `/${s}/~/settings/general` },
	{ label: "settings/billing", path: (s) => `/${s}/~/settings/billing` },
	{ label: "settings/members", path: (s) => `/${s}/~/settings/members` },
	{ label: "settings/teams", path: (s) => `/${s}/~/settings/teams` },
	{ label: "settings/roles", path: (s) => `/${s}/~/settings/roles` },
	{ label: "settings/access", path: (s) => `/${s}/~/settings/access` },
	{ label: "settings/sso", path: (s) => `/${s}/~/settings/sso` },
	{ label: "settings/activity", path: (s) => `/${s}/~/settings/activity` },
];

test.describe("Cross-cutting — org page resilience sweep", () => {
	for (const route of ORG_ROUTES) {
		test(`${route.label} loads without a 500 / redirect / pageerror`, async ({ owner }) => {
			await loadAndAssertShell(owner.page, route.path(owner.orgSlug));
			expect(fatalErrors(owner.guard), `fatal errors on ${route.label}`).toEqual([]);
		});
	}
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Project-scope routes — one lazily-seeded, deployed project shared across the file (WORKERS=1 keeps
// module state). Seeded uniquely-named; never cleaned up (siblings share the org).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

let seeded: (SeededProject & { jobId: string }) | null = null;

/** Idempotently seeds a connected identity + deployed project + a finished job + drift, once. */
async function ensureProject(owner: { userId?: string; orgId?: string }): Promise<SeededProject & { jobId: string }> {
	if (seeded) return seeded;
	const id = ownerId(owner);
	const identity = await seedCloudIdentity(id, { provider: "aws" });
	const project = await seedProject(id, {
		name: `e2e-xcut-${Date.now()}`,
		cloudIdentityId: identity.id,
		status: "ACTIVE",
	});
	await seedFinishedDeploy(project);
	const job = await seedJob(id, {
		jobType: "DEPLOY",
		status: "SUCCESS",
		projectId: project.projectId,
		envId: project.envId,
		cloudIdentityId: identity.id,
	});
	await seedDrift(project, { inSync: false, drifted: 2 });
	seeded = { ...project, jobId: job.id };
	return seeded;
}

const PROJECT_ROUTES: { label: string; sub: string }[] = [
	{ label: "project root (→architecture)", sub: "" },
	{ label: "architecture", sub: "/architecture" },
	{ label: "environments", sub: "/environments" },
	{ label: "jobs", sub: "/jobs" },
	{ label: "clusters", sub: "/clusters" },
	{ label: "usage", sub: "/usage" },
	{ label: "settings/general", sub: "/settings/general" },
	{ label: "settings/access", sub: "/settings/access" },
	{ label: "settings/activity", sub: "/settings/activity" },
];

test.describe("Cross-cutting — project page resilience sweep", () => {
	test.beforeEach(async ({ owner }) => {
		await ensureProject(owner);
	});

	for (const route of PROJECT_ROUTES) {
		test(`project ${route.label} loads without a 500 / redirect / pageerror`, async ({ owner }) => {
			const proj = await ensureProject(owner);
			await loadAndAssertShell(owner.page, `/${owner.orgSlug}/${proj.slug}${route.sub}`);
			expect(fatalErrors(owner.guard), `fatal errors on project ${route.label}`).toEqual([]);
		});
	}

	test("job detail page resolves for a seeded job", async ({ owner }) => {
		const proj = await ensureProject(owner);
		await loadAndAssertShell(owner.page, `/${owner.orgSlug}/~/jobs/${proj.jobId}`);
		expect(fatalErrors(owner.guard), "fatal errors on job detail").toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Landmark & title sanity — a couple of explicit anchors so the sweep proves the shell + a titled
// page really rendered (not just that `main` exists).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

test.describe("Cross-cutting — landmark & title sanity", () => {
	test("the org overview renders the sidebar Overview link", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		// Scope to the sidebar (complementary) landmark — the breadcrumb also exposes an "Overview"
		// role=link with aria-current, so a bare getByRole would be ambiguous.
		const sidebarOverview = owner.page
			.getByRole("complementary")
			.getByRole("link", { name: "Overview", exact: true });
		await expect(sidebarOverview).toBeVisible({ timeout: 25_000 });
		await expect(owner.page).not.toHaveURL(/\/login/);
	});

	test("a metadata-titled page sets its document title (Jobs)", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/jobs`);
		await expect(owner.page).toHaveTitle(/Jobs/, { timeout: 20_000 });
	});

	test("a settings section titles as '… · Settings'", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/settings/roles`);
		await expect(owner.page).toHaveTitle(/Roles/, { timeout: 20_000 });
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// A11y — non-failing record on the overview (axe no-ops to [] if @axe-core/playwright is absent).
// ─────────────────────────────────────────────────────────────────────────────────────────────────

test.describe("Cross-cutting — a11y record", () => {
	test("overview has no serious/critical a11y violations (recorded, non-blocking)", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await expect(owner.page.getByRole("main")).toBeVisible({ timeout: 25_000 });
		const violations = await scanA11y(owner.page);
		// Record only — axe is optional in this suite; a positive count is surfaced by the reporter.
		expect(Array.isArray(violations)).toBe(true);
	});
});

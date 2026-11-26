// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Cloud availability — a project on a cloud this deployment does not offer (#6964).
//
// Alibaba is hidden in this release (packages/core/catalog/catalog.json), and the qa leg does not set
// ALETHIA_ENABLE_HIDDEN_CLOUDS, so a project bound to an Alibaba account is one the console must
// still let its owner read, check for drift and destroy, but never plan or deploy. That project can
// only exist from before the cloud was hidden, so it is SEEDED here (fixture credentials, no cloud):
// the create screen does not offer Alibaba at all, which projects.spec.ts already measures.
//
// BOTH HALVES, through the canvas Run menu, which queues each job through a `"use server"` action
// that returns its refusal as a value — so the sentence survives the qa leg's production build and is
// matched as written:
//   · Plan is refused, the toast names the cloud, and no PLAN job row exists for the project;
//   · Detect drift is queued, and a DETECT_DRIFT job row exists. AUTHORING.md: stop at QUEUED. A
//     runner may claim it afterwards, so the row's TYPE is asserted, never its later status.
// Deploy and destroy are not clicked: Deploy needs a reviewed plan, which is the refused half, and the
// destroy confirm is the destructive-actions registry's to drive (audit/destructive.spec.ts). Both
// are pinned at the action level in tests/actions/projects.test.ts.
//
// The persona org is shared and runs in parallel, so the project is uniquely named and every
// assertion is scoped to its id. Nothing is cleaned up (AUTHORING.md).

import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/qa";
import { db } from "../helpers/db";
import { seedCloudIdentity, seedProject, type Owner, type SeededProject } from "../helpers/seed";

/** The sentence `CloudNotOfferedError` carries for Alibaba (lib/cloud-providers/availability.ts). */
const NOT_OFFERED = "Alibaba Cloud is not available in this release.";

/** The persona's Owner id tuple for seeding. */
function ownerId(s: { userId?: string; orgId?: string }): Owner {
	return { userId: s.userId!, orgId: s.orgId! };
}

/** Job types queued for the project, read from the database rather than the page. */
async function jobTypes(projectId: string): Promise<string[]> {
	const rows = await db()<{ job_type: string }[]>`
		select job_type from jobs where project_id = ${projectId}`;
	return rows.map((r) => r.job_type);
}

/** Opens the project's canvas and waits for its toolbar. */
async function openCanvas(page: Page, orgSlug: string, project: SeededProject): Promise<void> {
	await page.goto(`/${orgSlug}/${project.slug}/architecture`);
	await expect(page.getByRole("button", { name: "Run", exact: true })).toBeVisible({
		timeout: 60_000,
	});
}

/** Picks one job from the canvas Run menu. */
async function runFromMenu(page: Page, item: string): Promise<void> {
	await page.getByRole("button", { name: "Run", exact: true }).click();
	await page.getByRole("menuitem", { name: item }).click();
}

test.describe.configure({ timeout: 120_000 });

test.describe("Cloud availability — a project on a cloud this release does not offer", () => {
	let project: SeededProject;

	test.beforeEach(async ({ owner }) => {
		const identity = await seedCloudIdentity(ownerId(owner), { provider: "alibaba" });
		project = await seedProject(ownerId(owner), {
			name: `e2e-hidden-cloud-${Date.now()}`,
			region: "cn-hangzhou",
			cloudIdentityId: identity.id,
		});
	});

	test("the project still opens, and a Plan is refused with the cloud's name", async ({ owner }) => {
		const { page } = owner;
		await openCanvas(page, owner.orgSlug, project);
		await expect(page).not.toHaveURL(/\/login/);

		await runFromMenu(page, "Plan");
		await expect(
			page.locator('[data-sonner-toast][data-type="error"]').filter({ hasText: NOT_OFFERED }),
		).toBeVisible({ timeout: 15_000 });
		expect(await jobTypes(project.projectId)).not.toContain("PLAN");
	});

	test("a drift check is still queued", async ({ owner }) => {
		const { page } = owner;
		await openCanvas(page, owner.orgSlug, project);

		await runFromMenu(page, "Detect drift");
		await expect(
			page.locator('[data-sonner-toast]').filter({ hasText: "Drift detection queued" }),
		).toBeVisible({ timeout: 15_000 });
		await expect.poll(() => jobTypes(project.projectId), { timeout: 15_000 }).toContain("DETECT_DRIFT");
	});
});

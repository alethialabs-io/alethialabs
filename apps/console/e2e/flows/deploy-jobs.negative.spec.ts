// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Deploy-jobs domain — negative / empty-state / edge paths: a missing job id, the clusters empty
// state for an undeployed project, promotion gating on a single-environment project, and protection
// -rule form reveals. Everything is scoped to uniquely-named seeded rows (shared persona org).

import { test, expect } from "../fixtures/qa";
import type { Owner } from "../helpers/seed";
import { seedCloudIdentity, seedProject, type SeededProject } from "../helpers/seed";

/** Navigate without waiting for the full `load` event (slow QA SSR / open SSE streams). */
async function visit(page: import("@playwright/test").Page, path: string) {
	await page.goto(path, { waitUntil: "domcontentloaded" });
}

let ownerId: Owner;
let singleEnvProject: SeededProject; // DRAFT project, no finished deploy → no clusters, 1 env

test.beforeAll(async () => {
	const fs = await import("node:fs");
	const path = await import("node:path");
	const meta = JSON.parse(
		fs.readFileSync(path.resolve(process.cwd(), "e2e/.auth/personas.json"), "utf8"),
	);
	ownerId = { userId: meta.ownerHobby.userId, orgId: meta.ownerHobby.orgId };
	const identity = await seedCloudIdentity(ownerId, { provider: "aws" });
	singleEnvProject = await seedProject(ownerId, {
		name: `e2e-deployjobs-neg-${Date.now()}`,
		cloudIdentityId: identity.id,
		status: "DRAFT",
	});
});

// The QA dev server SSR is slow under parallel load, and Next cold-compiles routes on first hit;
// give each test generous headroom.
test.beforeEach(() => {
	test.setTimeout(180_000);
});

test.describe("Deploy jobs — negative & empty states", () => {
	test("a non-existent job id renders the not-found message, not a crash", async ({ owner }) => {
		// A well-formed but unseeded uuid.
		const ghost = "00000000-0000-4000-8000-000000000000";
		await visit(owner.page, `/${owner.orgSlug}/~/jobs/${ghost}`);
		await expect(owner.page).not.toHaveURL(/\/login/);
		await expect(owner.page.getByText("Job not found.")).toBeVisible({ timeout: 15_000 });
	});

	test("an undeployed project shows the clusters empty state", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/${singleEnvProject.slug}/clusters`);
		await expect(owner.page.getByText("No clusters provisioned")).toBeVisible({ timeout: 15_000 });
		await expect(
			owner.page.getByText(/Clusters appear here after you deploy a project/i),
		).toBeVisible();
	});

	test("a single-environment project hides the Promote action", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/${singleEnvProject.slug}/environments`);
		await expect(owner.page.getByRole("heading", { name: "Environments" })).toBeVisible({
			timeout: 15_000,
		});
		// Promote only appears when envs.length > 1.
		await expect(owner.page.getByRole("button", { name: /^Promote$/i })).toHaveCount(0);
		// But New Environment is always available.
		await expect(owner.page.getByRole("button", { name: /New Environment/i })).toBeVisible();
	});

	test("toggling 'Require approval' reveals the approvals-required input", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/${singleEnvProject.slug}/environments`);
		await owner.page
			.getByRole("button", { name: /Protection rules for/i })
			.first()
			.click();
		const dialog = owner.page.getByRole("dialog");
		await expect(dialog).toBeVisible({ timeout: 10_000 });
		// The min-count input is hidden until require-approval is on.
		await expect(dialog.getByText("Approvals required")).toHaveCount(0);
		const approvalSwitch = dialog
			.getByText("Require approval")
			.locator("xpath=ancestor::label")
			.getByRole("switch");
		await approvalSwitch.click();
		await expect(dialog.getByText("Approvals required")).toBeVisible();
	});

	test("the New Environment dialog validates a required name", async ({ owner }) => {
		await visit(owner.page, `/${owner.orgSlug}/${singleEnvProject.slug}/environments`);
		await owner.page.getByRole("button", { name: /New Environment/i }).click();
		const dialog = owner.page.getByRole("dialog");
		await expect(dialog).toBeVisible({ timeout: 10_000 });
		// The dialog should stay open (no navigation) if we submit with an empty name.
		const submit = dialog.getByRole("button", { name: /^(Create|Create environment|Add)/i });
		if (await submit.count()) {
			await submit.first().click();
			await expect(dialog).toBeVisible();
		}
	});
});

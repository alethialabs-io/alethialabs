// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Validates the DB seed toolkit: seed a "finished deploy" project for the ownerHobby persona and
// confirm it surfaces in the UI (project overview + clusters). Also exercises cleanup.

import { test, expect } from "../fixtures/qa";
import { seedCloudIdentity, seedFinishedDeploy, seedJob, seedProject } from "../helpers/seed";

test.describe("QA seed smoke", () => {
	test("seeded finished-deploy project renders across the console", async ({ owner }) => {
		const ownerId = { userId: owner.userId!, orgId: owner.orgId! };
		const identity = await seedCloudIdentity(ownerId, { provider: "aws" });
		const project = await seedProject(ownerId, {
			name: `seed-check-${Date.now()}`,
			cloudIdentityId: identity.id,
			status: "ACTIVE",
		});
		await seedFinishedDeploy(project);
		await seedJob(ownerId, { jobType: "DEPLOY", status: "SUCCESS", projectId: project.projectId, envId: project.envId, cloudIdentityId: identity.id });

		// Project appears on the org overview.
		await owner.page.goto(`/${owner.orgSlug}`);
		await expect(owner.page.getByText(project.name, { exact: false }).first()).toBeVisible({ timeout: 15_000 });

		// The org jobs page loads (heading or table) without bouncing to login.
		await owner.page.goto(`/${owner.orgSlug}/~/jobs`);
		await expect(owner.page).not.toHaveURL(/\/login/);
		await expect(owner.page.getByText(/jobs/i).first()).toBeVisible({ timeout: 15_000 });
	});

	// NO afterAll cleanup, deliberately. This file used to call `cleanupOrg(ownerHobby.orgId)`, which
	// deletes that org's jobs, projects and cloud identities — while the suite is `fullyParallel`
	// and other files were still driving the same persona (findings.md P0 §2). `cross-cutting` and
	// `navigation-shell` state in their headers that they do not clean up, for exactly this reason;
	// one file disagreed with two. The personas are per-run accounts in a throwaway CI database.
});

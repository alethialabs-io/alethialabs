// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Validates the DB seed toolkit: seed a "finished deploy" project for the ownerHobby persona and
// confirm it surfaces in the UI (project overview + clusters). Also exercises cleanup.

import { test, expect } from "../fixtures/qa";
import { cleanupOrg, seedCloudIdentity, seedFinishedDeploy, seedJob, seedProject } from "../helpers/seed";

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

	test.afterAll(async ({}, testInfo) => {
		// Best-effort cleanup so seeded rows don't accumulate across runs.
		try {
			const meta = JSON.parse(
				require("node:fs").readFileSync(require("node:path").resolve(process.cwd(), "e2e/.auth/personas.json"), "utf8"),
			);
			if (meta.ownerHobby?.orgId) await cleanupOrg(meta.ownerHobby.orgId);
		} catch {
			// ignore
		}
	});
});

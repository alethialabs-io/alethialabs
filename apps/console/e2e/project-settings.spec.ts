// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// E2E: context-aware (project-scoped) settings. The former "zone" layer was removed — a project is
// now a top-level Project. From a project's detail, the Settings entry opens the project's Activity
// under /{org}/{project}/settings/activity — scoped to this project (a scope caption, no Project
// facet, no org-wide CSV export). The nav-exclusion of org-only sections is covered by the unit
// test (tests/lib/settings-scope.test.ts). Run locally with `pnpm dev:up` + `pnpm -F console test:e2e`.

import { expect, test } from "./fixtures/auth";

test.describe("Project-scoped settings", () => {
	test("project Settings opens Activity scoped to the project", async ({
		authedPage: page,
		orgSlug,
	}) => {
		// TODO: drive the create-project (design-project) flow to guarantee a concrete project. Creating
		// a project needs a connected cloud identity, so for now we drill into an existing project from
		// the org overview and skip if the org has none.
		await page.goto(`/${orgSlug}`);
		await page.waitForLoadState("networkidle");

		// Project cards link to /{org}/{project}; the org-global scope (`/{org}/~/…`) is excluded.
		const projectLink = page
			.locator(`a[href^="/${orgSlug}/"]:not([href^="/${orgSlug}/~"])`)
			.first();
		test.skip(
			(await projectLink.count()) === 0,
			"no project in this org to drill into",
		);
		await projectLink.click();

		// Land on the project detail, then open its Settings.
		await page.waitForURL(/\/[^/]+\/[^/]+/, { timeout: 20_000 });
		await page.getByRole("link", { name: /settings/i }).first().click();

		// We're on the project-scoped Activity page.
		await page.waitForURL(/\/settings\/activity$/, { timeout: 20_000 });
		await expect(page.getByText(/activity in/i)).toBeVisible();

		// Project scope is locked → the search filter remains, but the Project facet and the
		// org-wide CSV export are gone.
		await expect(page.getByPlaceholder(/search actor, action or resource/i)).toBeVisible();
		await expect(page.getByRole("button", { name: /^project$/i })).toHaveCount(0);
		await expect(page.getByRole("button", { name: /export csv/i })).toHaveCount(0);
	});
});

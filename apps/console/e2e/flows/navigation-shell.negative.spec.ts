// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// E2E — Navigation shell, negative / not-found paths. Covers unknown routes under a *valid*
// org (an unknown project slug, an unknown project sub-page, an unknown org-global sub) and an
// unknown org slug entirely. The org layout calls notFound() before the shell renders, so these
// resolve to the branded full-page 404 (ErrorState) — never a redirect to /login for an
// authenticated user, and never a leaked 500.
//
// Run (self-check):
//   REUSE_AUTH=1 E2E_BASE_URL=http://localhost:3100 DEV_CONSOLE_LOG=/tmp/alethia-qa-console.log \
//     E2E_WORKERS=1 E2E_RETRIES=1 npx playwright test e2e/flows/navigation-shell.negative.spec.ts \
//     --output=test-results/wf-navigation-shell-neg

import { test, expect } from "../fixtures/qa";

test.describe("Navigation shell — unknown routes (404)", () => {
	test("an unknown project slug renders the branded 404, not /login", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/does-not-exist-${Date.now()}`);
		// The shared ErrorState: a 404 code line + a "Go home" action.
		await expect(owner.page.getByText("404", { exact: true })).toBeVisible({ timeout: 20_000 });
		await expect(owner.page.getByRole("link", { name: /go home/i })).toBeVisible();
		await expect(owner.page).not.toHaveURL(/\/login/);
	});

	test("an unknown project sub-page also 404s", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/does-not-exist-${Date.now()}/jobs`);
		await expect(owner.page.getByText("404", { exact: true })).toBeVisible({ timeout: 20_000 });
		await expect(owner.page).not.toHaveURL(/\/login/);
	});

	test("an unknown org-global (~) sub-page 404s", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/no-such-page-${Date.now()}`);
		await expect(owner.page.getByText("404", { exact: true })).toBeVisible({ timeout: 20_000 });
		await expect(owner.page).not.toHaveURL(/\/login/);
	});

	test("an unknown org slug renders the non-leaky org 404", async ({ owner }) => {
		await owner.page.goto(`/e2e-no-such-org-${Date.now()}`);
		await expect(
			owner.page.getByRole("heading", { name: /organization not found/i }),
		).toBeVisible({ timeout: 20_000 });
		await expect(owner.page.getByRole("link", { name: /go home/i })).toBeVisible();
		await expect(owner.page).not.toHaveURL(/\/login/);
	});

	test("the 'Go home' action on a 404 returns to the app root", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/does-not-exist-${Date.now()}`);
		const home = owner.page.getByRole("link", { name: /go home/i });
		await expect(home).toBeVisible({ timeout: 20_000 });
		await home.click();
		// Lands somewhere authenticated (org overview / root), not the 404 or /login.
		await expect(owner.page).not.toHaveURL(/does-not-exist/, { timeout: 20_000 });
		await expect(owner.page).not.toHaveURL(/\/login/);
	});
});

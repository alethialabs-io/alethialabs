// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// E2E — Cross-cutting resilience sweep, negative / auth-boundary paths. Complements the happy-path
// sweep: an UN-authenticated visitor hitting a protected page must be bounced to /login (never a
// 500, a hang, or a leaked authed shell). Uses the `owner` persona ONLY to borrow a real org slug,
// then drives a fresh no-storageState context so no session cookie is present.
//
// Unknown-route (404) negatives are covered by navigation-shell.negative.spec.ts and are NOT
// duplicated here.
//
// Run (self-check):
//   REUSE_AUTH=1 E2E_BASE_URL=http://localhost:3100 DEV_CONSOLE_LOG=/tmp/alethia-qa-console.log \
//     E2E_WORKERS=1 E2E_RETRIES=1 npx playwright test e2e/flows/cross-cutting.negative.spec.ts \
//     --output=test-results/wf-cross-cutting-neg

import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/qa";

/** Runs `fn` inside a fresh, unauthenticated browser context (no storageState) and always closes it. */
async function withAnonPage(
	browser: import("@playwright/test").Browser,
	fn: (page: Page) => Promise<void>,
): Promise<void> {
	const context = await browser.newContext();
	try {
		await fn(await context.newPage());
	} finally {
		await context.close();
	}
}

test.describe("Cross-cutting — unauthenticated access is bounced to /login", () => {
	// A representative set of protected surfaces: an org overview, an org-global page, and a settings
	// tab. All three sit behind the (private) layout's getOwner() gate.
	const PROTECTED: { label: string; path: (slug: string) => string }[] = [
		{ label: "org overview", path: (s) => `/${s}` },
		{ label: "org connectors", path: (s) => `/${s}/~/connectors` },
		{ label: "org billing settings", path: (s) => `/${s}/~/settings/billing` },
	];

	for (const route of PROTECTED) {
		test(`anon visitor to ${route.label} lands on /login (no 500, no authed shell)`, async ({
			owner,
			browser,
		}) => {
			const slug = owner.orgSlug;
			await withAnonPage(browser, async (page) => {
				const resp = await page.goto(route.path(slug), { waitUntil: "domcontentloaded" });
				if (resp) expect(resp.status(), `document status for ${route.label}`).toBeLessThan(500);
				await page.waitForURL(/\/login/, { timeout: 20_000 });
				await expect(page).toHaveURL(/\/login/);
				// The authed shell must NOT have leaked to an anonymous visitor.
				await expect(page.getByRole("link", { name: "Overview", exact: true })).toHaveCount(0);
			});
		});
	}

	test("anon visitor to a project route also bounces to /login", async ({ owner, browser }) => {
		const slug = owner.orgSlug;
		await withAnonPage(browser, async (page) => {
			await page.goto(`/${slug}/any-project/jobs`, { waitUntil: "domcontentloaded" });
			await page.waitForURL(/\/login/, { timeout: 20_000 });
			await expect(page).toHaveURL(/\/login/);
		});
	});
});

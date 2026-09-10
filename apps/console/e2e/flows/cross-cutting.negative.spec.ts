// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// E2E — Cross-cutting resilience sweep, negative / auth-boundary paths. Complements the happy-path
// sweep: an UN-authenticated visitor hitting a protected page must be bounced to /login (never a
// 500, a hang, or a leaked authed shell). Uses the `owner` persona ONLY to borrow a real org slug,
// then drives a fresh no-storageState context so no session cookie is present.
//
// THE LEAK ASSERTION IS THE SHELL, NOT A LINK IN IT. It used to be "there is no `Overview` link",
// which is one row of one component: a bounce that rendered the whole authenticated sidebar but
// happened to have renamed that row would have passed. The `complementary` landmark IS the org
// sidebar — the same handle `helpers/shell.ts` waits on for the positive case — so the two
// directions of the same fact are now measured against the same thing.
//
// There is no middleware here: every private route redirects from its own page guard
// (`app/(private)/layout.tsx` says so explicitly and deliberately does not duplicate it). That is
// why the list below is a LIST — a per-page guard is a set that the next page forgets to join, and
// this spec is the only thing that would notice.
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

/** The bounce, asserted the same way everywhere: no 5xx, lands on /login, no authed shell painted. */
async function expectBounced(page: Page, url: string, label: string): Promise<void> {
	const resp = await page.goto(url, { waitUntil: "domcontentloaded" });
	if (resp) expect(resp.status(), `document status for ${label}`).toBeLessThan(500);
	await page.waitForURL(/\/login/, { timeout: 20_000 });
	await expect(page, `landed on /login for ${label}`).toHaveURL(/\/login/);
	// The authed shell must NOT have leaked to an anonymous visitor.
	await expect(page.getByRole("complementary"), `org sidebar for ${label}`).toHaveCount(0);
}

test.beforeEach(() => {
	test.setTimeout(120_000);
});

test.describe("Cross-cutting — unauthenticated access is bounced to /login", () => {
	// A representative set of protected surfaces: the org root, two org-global pages this wave's
	// domain owns (jobs, evidence), a connector surface, and a settings tab. All of them sit behind
	// their own page guard.
	const PROTECTED: { label: string; path: (slug: string) => string }[] = [
		{ label: "org overview", path: (s) => `/${s}` },
		{ label: "org connectors", path: (s) => `/${s}/~/connectors` },
		{ label: "org jobs", path: (s) => `/${s}/~/jobs` },
		{ label: "org clusters", path: (s) => `/${s}/~/clusters` },
		{ label: "org evidence", path: (s) => `/${s}/~/evidence` },
		{ label: "org billing settings", path: (s) => `/${s}/~/settings/billing` },
	];

	for (const route of PROTECTED) {
		test(`anon visitor to ${route.label} lands on /login (no 500, no authed shell)`, async ({
			owner,
			browser,
		}) => {
			const slug = owner.orgSlug;
			await withAnonPage(browser, async (page) => {
				await expectBounced(page, route.path(slug), route.label);
			});
		});
	}

	test("anon visitor to a project route also bounces to /login", async ({ owner, browser }) => {
		const slug = owner.orgSlug;
		await withAnonPage(browser, async (page) => {
			await expectBounced(page, `/${slug}/any-project/jobs`, "project jobs");
		});
	});

	test("anon visitor to a job detail page bounces before the job is resolved", async ({
		owner,
		browser,
	}) => {
		// A well-formed uuid that resolves to nothing. The point is that the bounce happens on the
		// session, not on the lookup: an anonymous visitor must not be able to tell a job that
		// exists from one that does not.
		const slug = owner.orgSlug;
		await withAnonPage(browser, async (page) => {
			await expectBounced(
				page,
				`/${slug}/~/jobs/00000000-0000-4000-8000-000000000000`,
				"job detail",
			);
			await expect(page.getByText("Job not found.")).toHaveCount(0);
		});
	});
});

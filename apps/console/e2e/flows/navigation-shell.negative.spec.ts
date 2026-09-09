// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// E2E — Navigation shell, negative / not-found paths. Unknown routes under a *valid* org (an
// unknown project slug, an unknown project sub-page, an unknown org-global sub) and an unknown org
// slug entirely. All resolve to the branded ErrorState — never a redirect to /login for an
// authenticated user, and never a leaked 500.
//
// TWO DIFFERENT 404s, AND THE DIFFERENCE IS LOAD-BEARING. An unknown ORG slug is thrown by
// `[org]/layout.tsx`, which is OUTSIDE the boundary `[org]/not-found.tsx` provides (Next hands a
// segment's not-found.tsx to the LayoutRouter for that segment's CHILDREN slot), so it is answered
// full-page by `(private)/not-found.tsx` — "Organization not found". An unknown project or
// org-global sub-page is thrown BELOW that layout and is answered IN-SHELL by
// `[org]/not-found.tsx` — "Not found". Each test below states which of the two it is driving,
// because a positive assertion on one of them passes on the other the moment somebody edits a
// heading.
//
// WHAT #4267 CHANGED HERE. "Go home" on both 404s is now reachable as a LINK. It always rendered an
// `<a href="/">`, but base-ui's Button stamps `role="button"` on any non-native render
// (`use-button/useButton.js` merges `{role: 'button'}` when `nativeButton` is false), so the only
// way out of a 404 announced itself as a button and `getByRole("link", { name: /go home/i })` — the
// assertion this file has carried since it was written — could not find it at all. Three of this
// file's five tests were recorded `failed` in `e2e/gate-baseline.json` on exactly that.
//
// THIS FILE IS NOT THE ONLY INSTRUMENT. The layout boundary-escape invariant in
// `scripts/check-route-states.mjs` is a required check and watches the same mechanism statically;
// before the release gate the `qa` project ran nowhere in CI, so this file sat green-by-absence
// while a bad org slug rendered the root "Page not found" for months (#3891).
//
// Run (self-check):
//   REUSE_AUTH=1 E2E_BASE_URL=http://localhost:3100 DEV_CONSOLE_LOG=/tmp/alethia-qa-console.log \
//     E2E_WORKERS=1 E2E_RETRIES=1 npx playwright test e2e/flows/navigation-shell.negative.spec.ts

import { test, expect } from "../fixtures/qa";

test.describe("Navigation shell — unknown routes (404)", () => {
	test("an unknown project slug renders the in-shell 404, not /login", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/does-not-exist-${Date.now()}`);
		// The shared ErrorState: a 404 code line + a "Go home" action.
		await expect(owner.page.getByText("404", { exact: true })).toBeVisible({ timeout: 20_000 });
		await expect(owner.page.getByRole("link", { name: /go home/i })).toBeVisible();
		await expect(owner.page).not.toHaveURL(/\/login/);
	});

	test("it is answered INSIDE the shell — the org resolved, so the sidebar is still there", async ({ owner }) => {
		// The variant matters: `[org]/not-found.tsx` renders the compact in-content ErrorState, not
		// the `fullPage` one, precisely because the org DID resolve. A full-page panel painted
		// inside the dashboard chrome is the defect this asserts against.
		await owner.page.goto(`/${owner.orgSlug}/does-not-exist-${Date.now()}`);
		await expect(owner.page.getByText("404", { exact: true })).toBeVisible({ timeout: 20_000 });
		await expect(owner.page.getByRole("complementary")).toBeVisible();
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

	test("an unknown org slug renders the non-leaky ORG 404, not the root one", async ({ owner }) => {
		await owner.page.goto(`/e2e-no-such-org-${Date.now()}`);
		await expect(owner.page.getByRole("heading", { name: /organization not found/i })).toBeVisible({
			timeout: 20_000,
		});
		await expect(owner.page.getByRole("link", { name: /go home/i })).toBeVisible();
		// AND NOT the root app/not-found.tsx, which is what actually rendered before #3891. Its
		// heading is "Page not found" and it is the only 404 in the console carrying a "Sign in"
		// action — so a positive assertion on the org copy alone passes on the wrong page the
		// moment somebody renames a heading. Both halves are asserted for that reason.
		await expect(owner.page.getByRole("heading", { name: /^page not found$/i })).toHaveCount(0);
		await expect(owner.page.getByRole("link", { name: /sign in/i })).toHaveCount(0);
		await expect(owner.page).not.toHaveURL(/\/login/);
	});

	test("the org 404 is FULL PAGE — there is no shell behind an org that did not resolve", async ({ owner }) => {
		// The mirror of the in-shell assertion above, and the reason the two boundaries cannot be
		// merged: with no resolved org there is no id to render the dashboard chrome with, so the
		// sidebar landmark must be absent here and present there.
		await owner.page.goto(`/e2e-no-such-org-${Date.now()}`);
		await expect(owner.page.getByRole("heading", { name: /organization not found/i })).toBeVisible({
			timeout: 20_000,
		});
		await expect(owner.page.getByRole("complementary")).toHaveCount(0);
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

	test("an unknown project slug names the PROJECT, not 'this page'", async ({ owner }) => {
		test.fixme(
			true,
			"BUG: /{org}/{missing-project} is answered by the org-level fallback boundary, whose copy is " +
				"deliberately resource-neutral (\"Not found\" / \"This page doesn't exist\"). The project scope " +
				"has never added the `not-found.tsx` beside its page that would let it name its own resource, " +
				"so the most common 404 in the console tells the user nothing about a project #4431",
		);
		await owner.page.goto(`/${owner.orgSlug}/does-not-exist-${Date.now()}`);
		await expect(owner.page.getByRole("heading", { name: /project not found/i })).toBeVisible({ timeout: 20_000 });
	});
});

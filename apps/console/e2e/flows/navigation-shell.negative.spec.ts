// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// E2E — Navigation shell, negative / not-found paths. Unknown routes under a *valid* org (an
// unknown project slug, an unknown project sub-page, an unknown org-global sub) and an unknown org
// slug entirely. All resolve to the branded ErrorState — never a redirect to /login for an
// authenticated user, and never a leaked 500.
//
// THREE DIFFERENT 404s, AND THE DIFFERENCES ARE LOAD-BEARING. Each test below states which one it
// is driving, because a positive assertion on any of them passes on another the moment somebody
// edits a heading:
//
//   · an unknown ORG slug is thrown by `[org]/layout.tsx`, which is OUTSIDE the boundary
//     `[org]/not-found.tsx` provides (Next hands a segment's not-found.tsx to the LayoutRouter for
//     that segment's CHILDREN slot), so it is answered FULL PAGE by `(private)/not-found.tsx` —
//     "Organization not found", with no shell behind it;
//   · an unknown PROJECT slug is answered IN-SHELL by `[org]/[project]/not-found.tsx` (#3880) —
//     "Project not found", whose way out is the org's project list rather than the app root;
//   · `[org]/not-found.tsx` is the org-level FALLBACK for anything below `[org]` with no nearer
//     boundary. THIS FILE DRIVES NOTHING THAT REACHES IT, and saying so is the point: the only
//     `notFound()` calls below `[org]` today are in `[project]/**` and `~/support/cases/[id]`, and
//     both have their own nearer boundary. Its copy is generic on purpose, so a test that asserted
//     it here would in fact be measuring whichever boundary really answered.
//
// THE FIRST DRAFT OF THIS FILE GOT THAT WRONG, and the way it got it wrong is worth keeping. It
// asserted a "Go home" action on the unknown-project 404 — because `[org]/not-found.tsx`'s own
// header names "a project slug that does not resolve" as one of the throws that arrive at it. That
// sentence has been false since #3880 added the project boundary. The tree was read, the comment
// was believed, and the run said "Project not found … All projects".
//
// WHAT #4267 CHANGED HERE. The way out of a 404 is reachable as a LINK on every boundary this file
// drives. Each always rendered an `<a href>`, but base-ui's Button stamps `role="button"` on any
// non-native render (`use-button/useButton.js` merges `{role: "button"}` when `nativeButton` is
// false), so the only way off the page announced itself as a button and
// `getByRole("link", …)` could not find it at all.
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
	test("an unknown project slug renders the PROJECT 404, which names the project", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/does-not-exist-${Date.now()}`);
		await expect(owner.page.getByText("404", { exact: true })).toBeVisible({ timeout: 20_000 });
		// `[org]/[project]/not-found.tsx` (#3880), NOT the org-level fallback. The distinction is
		// the whole finding of this file's first run: the copy here names the resource that is
		// actually missing, and asserting the fallback's generic "Not found" would pass on a
		// regression that deleted this boundary.
		await expect(owner.page.getByRole("heading", { name: /^project not found$/i })).toBeVisible();
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

	test("the way out of the project 404 is a LINK, and it lands on the org's projects", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/does-not-exist-${Date.now()}`);
		// Scoped to `main`: the topbar's project switcher is also named "All projects", and it is
		// a button. The one being measured is the 404's own action.
		const out = owner.page.getByRole("main").getByRole("link", { name: "All projects", exact: true });
		await expect(out).toBeVisible({ timeout: 20_000 });
		await out.click();
		await owner.page.waitForURL(new RegExp(`/${owner.orgSlug}(\\?|$)`), { timeout: 20_000 });
		await expect(owner.page).not.toHaveURL(/\/login/);
	});
});

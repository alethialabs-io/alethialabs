// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Harness smoke: proves the QA fixture surface end-to-end — a persona storageState loads an authed
// session, navigation works, and the perf + console-error collectors attach. Run this first when
// bringing the suite up; if it fails, nothing downstream will work.

import { test, expect } from "../fixtures/qa";

test.describe("QA harness smoke", () => {
	test("ownerHobby persona is authenticated and lands on its org overview", async ({ owner }) => {
		// The resolved slug must be a real org, not a stalled public route.
		expect(["onboarding", "login", "signup"]).not.toContain(owner.orgSlug);
		await owner.page.goto(`/${owner.orgSlug}`);
		await expect(owner.page).toHaveURL(new RegExp(`/${owner.orgSlug}(\\?|/|$)`));
		// The overview's create affordance, asserted in the ONE form that does not depend on what
		// is in the org. The EmptyState's "Create a Project" LINK renders only while the org has
		// no projects at all (overview-client.tsx:134-147); the toolbar's Create menu renders in
		// every state (overview-toolbar.tsx:94).
		//
		// Asserting the link made a HARNESS smoke test depend on org CONTENTS, and the suite is
		// `fullyParallel` over a shared persona: `_seed-smoke.spec.ts` seeds a project into this
		// same ownerHobby org and — correctly, and with its reason written down — does not clean
		// up. So the two files disagreed about whether this org is empty, and the loser was
		// whichever ran second. Measured on run 34251055671: this failed on both attempts with
		// `seed-check-1788886367846` on screen, which reads as "the create affordance broke" and
		// is nothing of the kind.
		await expect(owner.page.getByRole("button", { name: /^create$/i }).first()).toBeVisible({
			timeout: 15_000,
		});
	});

	test("persona session is not bounced to /login", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/usage`);
		await expect(owner.page).not.toHaveURL(/\/login/);
	});
});

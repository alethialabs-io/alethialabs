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
		// The org overview offers a create-project affordance.
		await expect(owner.page.getByRole("link", { name: /create.*project/i }).first()).toBeVisible({
			timeout: 15_000,
		});
	});

	test("persona session is not bounced to /login", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}/~/usage`);
		await expect(owner.page).not.toHaveURL(/\/login/);
	});
});

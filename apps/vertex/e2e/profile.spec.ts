// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { test, expect } from "./fixtures/auth";

test.describe("Profile page", () => {
	test("loads with heading", async ({ authedPage: page }) => {
		await page.goto("/dashboard/profile");
		await expect(
			page.getByRole("heading", { name: /profile/i }),
		).toBeVisible();
	});

	test("shows user email", async ({ authedPage: page }) => {
		await page.goto("/dashboard/profile");
		await expect(page.getByText(/@/)).toBeVisible();
	});
});

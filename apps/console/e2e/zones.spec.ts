// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { test, expect } from "./fixtures/auth";

test.describe("Zones page", () => {
	test("loads", async ({ authedPage: page }) => {
		await page.goto("/dashboard/zones");
		await expect(page).toHaveURL(/\/dashboard\/zones/);
	});

	test("shows empty state or zone cards", async ({ authedPage: page }) => {
		await page.goto("/dashboard/zones");
		const cards = await page.locator("[href^='/dashboard/zones/']").count();
		if (cards === 0) {
			await expect(page.getByText("No zones yet")).toBeVisible();
		} else {
			await expect(
				page.locator("[href^='/dashboard/zones/']").first(),
			).toBeVisible();
		}
	});
});

// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { test, expect } from "./fixtures/auth";

test.describe("Vineyards page", () => {
	test("loads with heading", async ({ authedPage: page }) => {
		await page.goto("/dashboard/vineyards");
		await expect(
			page.getByRole("heading", { name: "Vineyards" }),
		).toBeVisible();
	});

	test("shows empty state or vineyard cards", async ({ authedPage: page }) => {
		await page.goto("/dashboard/vineyards");
		const hasCards = await page.locator("[href^='/dashboard/vineyards/']").count();
		if (hasCards === 0) {
			await expect(page.getByText("No vineyards yet")).toBeVisible();
		} else {
			await expect(page.locator("[href^='/dashboard/vineyards/']").first()).toBeVisible();
		}
	});
});

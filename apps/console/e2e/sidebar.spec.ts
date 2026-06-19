// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { test, expect } from "./fixtures/auth";

test.describe("Sidebar navigation", () => {
	test("renders all nav items", async ({ authedPage: page }) => {
		await expect(page.getByRole("link", { name: "Overview" })).toBeVisible();
		await expect(page.getByRole("link", { name: "Vineyards" })).toBeVisible();
		await expect(page.getByRole("link", { name: /plant/i })).toBeVisible();
		await expect(page.getByRole("link", { name: "Jobs" })).toBeVisible();
		await expect(page.getByRole("link", { name: "Connectors" })).toBeVisible();
		await expect(page.getByRole("link", { name: "Runners" })).toBeVisible();
	});

	test("Overview is active on /dashboard", async ({ authedPage: page }) => {
		const overview = page.getByRole("link", { name: "Overview" });
		await expect(overview).toBeVisible();
	});

	test("navigates to Vineyards", async ({ authedPage: page }) => {
		await page.getByRole("link", { name: "Vineyards" }).first().click();
		await page.waitForURL(/\/dashboard\/vineyards/);
		await expect(page.getByText("Vineyards")).toBeVisible();
	});

	test("navigates to Connectors", async ({ authedPage: page }) => {
		await page.getByRole("link", { name: "Connectors" }).first().click();
		await page.waitForURL(/\/dashboard\/connectors/);
		await expect(page.getByText("Connectors")).toBeVisible();
	});
});

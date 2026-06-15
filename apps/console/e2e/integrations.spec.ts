// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { test, expect } from "./fixtures/auth";

test.describe("Integrations page", () => {
	test("loads with heading", async ({ authedPage: page }) => {
		await page.goto("/dashboard/integrations");
		await expect(
			page.getByRole("heading", { name: "Integrations" }),
		).toBeVisible();
	});

	test("shows filter sidebar", async ({ authedPage: page }) => {
		await page.goto("/dashboard/integrations");
		await expect(page.getByRole("button", { name: /all/i })).toBeVisible();
		await expect(page.getByRole("button", { name: /git/i })).toBeVisible();
		await expect(page.getByRole("button", { name: /cloud/i })).toBeVisible();
	});

	test("shows search input", async ({ authedPage: page }) => {
		await page.goto("/dashboard/integrations");
		await expect(
			page.getByPlaceholder(/search/i),
		).toBeVisible();
	});

	test("search filters integrations", async ({ authedPage: page }) => {
		await page.goto("/dashboard/integrations");
		await page.getByPlaceholder(/search/i).fill("GitHub");
		await expect(page.getByText("GitHub")).toBeVisible();
	});
});

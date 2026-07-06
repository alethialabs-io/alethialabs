// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { test, expect } from "./fixtures/auth";

test.describe("Create a Project (design-project form)", () => {
	test.beforeEach(async ({ authedPage: page }) => {
		await page.goto("/dashboard/design-project");
		await page.waitForLoadState("networkidle");
	});

	test("loads with heading", async ({ authedPage: page }) => {
		await expect(
			page.getByRole("heading", { name: /create a project/i }),
		).toBeVisible();
	});

	test("shows core sections", async ({ authedPage: page }) => {
		await expect(page.getByLabel(/project name/i)).toBeVisible();
		await expect(page.getByText("Databases")).toBeVisible();
		await expect(page.getByText("Caches")).toBeVisible();
		await expect(page.getByText("DNS & Security")).toBeVisible();
		await expect(page.getByText("Secrets")).toBeVisible();
	});

	test("submit button exists", async ({ authedPage: page }) => {
		await expect(
			page.getByRole("button", { name: /create project/i }),
		).toBeVisible();
	});

	test("project name accepts input", async ({ authedPage: page }) => {
		const input = page.getByLabel(/project name/i);
		await input.fill("test-project");
		await expect(input).toHaveValue("test-project");
	});
});

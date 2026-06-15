// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { test, expect } from "./fixtures/auth";

test.describe("Plant a Vine form", () => {
	test.beforeEach(async ({ authedPage: page }) => {
		await page.goto("/dashboard/plant");
	});

	test("loads with heading", async ({ authedPage: page }) => {
		await expect(
			page.getByRole("heading", { name: /plant a vine/i }),
		).toBeVisible();
	});

	test("shows Project Basics section", async ({ authedPage: page }) => {
		await expect(page.getByText("Project Basics")).toBeVisible();
		await expect(page.getByLabel(/project name/i)).toBeVisible();
	});

	test("shows AWS & Network section", async ({ authedPage: page }) => {
		await expect(page.getByText("AWS & Network")).toBeVisible();
	});

	test("shows Platform & Versions section", async ({ authedPage: page }) => {
		await expect(page.getByText("Platform & Versions")).toBeVisible();
	});

	test("shows Repositories section", async ({ authedPage: page }) => {
		await expect(page.getByText("Repositories & GitOps")).toBeVisible();
	});

	test("shows Database section", async ({ authedPage: page }) => {
		await expect(page.getByText("Database")).toBeVisible();
	});

	test("shows Advanced section", async ({ authedPage: page }) => {
		await expect(page.getByText("Advanced Configuration")).toBeVisible();
	});

	test("project name accepts input", async ({ authedPage: page }) => {
		const input = page.getByLabel(/project name/i);
		await input.fill("test-vine");
		await expect(input).toHaveValue("test-vine");
	});

	test("cost preview visible on xl screens", async ({ authedPage: page }) => {
		await page.setViewportSize({ width: 1400, height: 900 });
		await expect(page.getByText("Monthly Estimate")).toBeVisible();
	});

	test("Add Admin button opens combobox", async ({ authedPage: page }) => {
		await page.getByRole("button", { name: /add admin/i }).click();
		await expect(page.getByPlaceholder(/search or type/i)).toBeVisible();
	});

	test("submit button exists", async ({ authedPage: page }) => {
		await expect(
			page.getByRole("button", { name: /plant vine/i }),
		).toBeVisible();
	});
});

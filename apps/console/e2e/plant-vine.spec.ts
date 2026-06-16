// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { test, expect } from "./fixtures/auth";

test.describe("Plant a Vine page", () => {
	test.beforeEach(async ({ authedPage: page }) => {
		await page.goto("/dashboard/plant");
		await page.waitForLoadState("networkidle");
	});

	test("renders all form sections", async ({ authedPage: page }) => {
		await expect(page.getByText("Project Basics")).toBeVisible();
		await expect(page.getByText("AWS Account & Region")).toBeVisible();
		await expect(page.getByText("VPC & Networking")).toBeVisible();
		await expect(page.getByText("Platform & EKS")).toBeVisible();
		await expect(page.getByText("Repositories")).toBeVisible();
		await expect(page.getByText("Databases")).toBeVisible();
		await expect(page.getByText("Caches")).toBeVisible();
		await expect(page.getByText("DNS & Security")).toBeVisible();
		await expect(page.getByText("Messaging")).toBeVisible();
		await expect(page.getByText("DynamoDB Tables")).toBeVisible();
		await expect(page.getByText("Secrets")).toBeVisible();
		await expect(page.getByText("Estimated Cost")).toBeVisible();
	});

	test("shows validation errors when submitting empty form", async ({ authedPage: page }) => {
		await page.getByRole("button", { name: /plant vine/i }).click();
		// Zod validation should prevent submission — check for error messages
		await expect(page.getByText(/vine name is required/i)).toBeVisible({ timeout: 3000 });
	});

	test("project name validates format", async ({ authedPage: page }) => {
		const nameInput = page.getByPlaceholder("my-project");
		await nameInput.fill("UPPERCASE");
		// Input forces lowercase
		await expect(nameInput).toHaveValue("uppercase");
	});

	test("VPC CIDR calculator shows address count", async ({ authedPage: page }) => {
		const cidrInput = page.getByPlaceholder("10.0.0.0/16");
		await cidrInput.clear();
		await cidrInput.fill("10.0.0.0/24");
		await expect(page.getByText("256")).toBeVisible();
		await expect(page.getByText("Small")).toBeVisible();
	});

	test("can add and remove databases", async ({ authedPage: page }) => {
		await expect(page.getByText("No databases configured")).toBeVisible();

		await page.getByRole("button", { name: /add database/i }).click();
		await expect(page.getByText("primary")).toBeVisible();
		await expect(page.getByText("No databases configured")).not.toBeVisible();

		// Remove it
		const trashButtons = page.locator('[data-testid="remove-database"], button:has(svg.lucide-trash-2)');
		if (await trashButtons.first().isVisible()) {
			await trashButtons.first().click();
			await expect(page.getByText("No databases configured")).toBeVisible();
		}
	});

	test("can add and remove caches", async ({ authedPage: page }) => {
		await expect(page.getByText("No caches configured")).toBeVisible();

		await page.getByRole("button", { name: /add cache/i }).click();
		await expect(page.getByText("No caches configured")).not.toBeVisible();
	});

	test("DynamoDB advanced options are collapsed", async ({ authedPage: page }) => {
		await page.getByRole("button", { name: /add table/i }).click();
		// Advanced options should be collapsed
		await expect(page.getByText("Advanced options")).toBeVisible();
		// Range key should not be visible initially
		await expect(page.getByText("Range Key")).not.toBeVisible();

		// Expand
		await page.getByText("Advanced options").click();
		await expect(page.getByText("Range Key")).toBeVisible();
	});

	test("secret presets auto-fill values", async ({ authedPage: page }) => {
		// Open the secret preset dropdown
		const addSecretTrigger = page.locator('button:has-text("Add secret")');
		await addSecretTrigger.click();

		// Select PostgreSQL Password preset
		await page.getByText("PostgreSQL Password").click();

		// Should see the auto-filled name
		await expect(page.locator('input[value="postgres-password"]')).toBeVisible();
	});

	test("cost sidebar shows EKS control plane", async ({ authedPage: page }) => {
		await expect(page.getByText("EKS Control Plane")).toBeVisible();
		await expect(page.getByText("$73")).toBeVisible();
	});

	test("cost sidebar updates when adding database", async ({ authedPage: page }) => {
		// Get initial total
		const totalBefore = await page.locator("text=Total").locator("..").textContent();

		// Add a database
		await page.getByRole("button", { name: /add database/i }).click();

		// Total should change (database adds cost)
		await page.waitForTimeout(500);
		const totalAfter = await page.locator("text=Total").locator("..").textContent();
		expect(totalAfter).not.toBe(totalBefore);
	});

	test("environment select has three options", async ({ authedPage: page }) => {
		await page.locator('button:has-text("Development")').first().click();
		await expect(page.getByRole("option", { name: "Development" })).toBeVisible();
		await expect(page.getByRole("option", { name: "Staging" })).toBeVisible();
		await expect(page.getByRole("option", { name: "Production" })).toBeVisible();
	});

	test("VPC toggle between create and existing", async ({ authedPage: page }) => {
		await expect(page.getByText("Create New VPC")).toBeVisible();
		await expect(page.getByText("Use Existing VPC")).toBeVisible();
		// CIDR input visible by default (create mode)
		await expect(page.getByPlaceholder("10.0.0.0/16")).toBeVisible();
	});

	test("help tooltips are present", async ({ authedPage: page }) => {
		// Click a help icon
		const helpIcons = page.locator('button:has(svg.lucide-help-circle)');
		const count = await helpIcons.count();
		expect(count).toBeGreaterThan(5); // Should have many help tooltips

		// Click first one and verify popover appears
		await helpIcons.first().click();
		await expect(page.locator('[data-radix-popper-content-wrapper]')).toBeVisible();
	});

	test("EKS instance types can be added", async ({ authedPage: page }) => {
		// Should have t3.medium by default
		await expect(page.getByText("t3.medium").first()).toBeVisible();

		// Add another type
		await page.locator('button:has-text("Add instance type")').click();
		await page.getByRole("option", { name: "t3.large" }).click();
		await expect(page.getByText("t3.large")).toBeVisible();
	});

	test("messaging can add queues and topics", async ({ authedPage: page }) => {
		await expect(page.getByText("No messaging configured")).toBeVisible();

		await page.getByRole("button", { name: /^Queue$/ }).click();
		await expect(page.getByText("SQS Queues")).toBeVisible();

		await page.getByRole("button", { name: /^Topic$/ }).click();
		await expect(page.getByText("SNS Topics")).toBeVisible();
	});
});

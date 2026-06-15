import { test, expect } from "./fixtures/auth";

test.describe("Sidebar navigation", () => {
	test("renders all nav items", async ({ authedPage: page }) => {
		await expect(page.getByRole("link", { name: "Overview" })).toBeVisible();
		await expect(page.getByRole("link", { name: "Vineyards" })).toBeVisible();
		await expect(page.getByRole("link", { name: /plant/i })).toBeVisible();
		await expect(page.getByRole("link", { name: "Jobs" })).toBeVisible();
		await expect(page.getByRole("link", { name: "Integrations" })).toBeVisible();
		await expect(page.getByRole("link", { name: "Workers" })).toBeVisible();
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

	test("navigates to Integrations", async ({ authedPage: page }) => {
		await page.getByRole("link", { name: "Integrations" }).first().click();
		await page.waitForURL(/\/dashboard\/integrations/);
		await expect(page.getByText("Integrations")).toBeVisible();
	});
});

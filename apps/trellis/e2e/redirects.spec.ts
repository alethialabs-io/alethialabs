import { test, expect } from "./fixtures/auth";

test.describe("Redirects", () => {
	test("/dashboard/vines → /dashboard/vineyards", async ({ authedPage: page }) => {
		await page.goto("/dashboard/vines");
		await page.waitForURL(/\/dashboard\/vineyards/);
	});

	test("/dashboard/clusters → /dashboard", async ({ authedPage: page }) => {
		await page.goto("/dashboard/clusters");
		await page.waitForURL(/\/dashboard$/);
	});

	test("/dashboard/history → /dashboard/jobs", async ({ authedPage: page }) => {
		await page.goto("/dashboard/history");
		await page.waitForURL(/\/dashboard\/jobs/);
	});

	test("/dashboard/providers → /dashboard/integrations", async ({ authedPage: page }) => {
		await page.goto("/dashboard/providers");
		await page.waitForURL(/\/dashboard\/integrations/);
	});

	test("/dashboard/git → /dashboard/integrations", async ({ authedPage: page }) => {
		await page.goto("/dashboard/git");
		await page.waitForURL(/\/dashboard\/integrations/);
	});
});

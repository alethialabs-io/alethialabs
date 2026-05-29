import { test, expect } from "./fixtures/auth";

test.describe("Jobs page", () => {
	test("loads with heading", async ({ authedPage: page }) => {
		await page.goto("/dashboard/jobs");
		await expect(
			page.getByRole("heading", { name: "Jobs" }),
		).toBeVisible();
	});

	test("shows table or empty state", async ({ authedPage: page }) => {
		await page.goto("/dashboard/jobs");
		const hasTable = await page.locator("table").count();
		if (hasTable === 0) {
			await expect(page.getByText("No jobs yet")).toBeVisible();
		}
	});
});

import { test, expect } from "./fixtures/auth";

test.describe("Workers page", () => {
	test("loads with heading", async ({ authedPage: page }) => {
		await page.goto("/dashboard/workers");
		await expect(page.getByText("Workers")).toBeVisible();
	});
});

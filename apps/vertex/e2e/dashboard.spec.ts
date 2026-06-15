import { test, expect } from "./fixtures/auth";

test.describe("Dashboard overview", () => {
	test("loads and shows heading", async ({ authedPage: page }) => {
		await expect(page.getByText("Overview")).toBeVisible();
	});

	test("shows stat cards", async ({ authedPage: page }) => {
		await expect(page.getByText("Total Vines")).toBeVisible();
		await expect(page.getByText("Active")).toBeVisible();
		await expect(page.getByText("Vineyards")).toBeVisible();
	});

	test("has Plant a Vine button", async ({ authedPage: page }) => {
		await expect(
			page.getByRole("link", { name: /plant/i }),
		).toBeVisible();
	});
});

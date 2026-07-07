// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { test, expect } from "./fixtures/auth";

test.describe("Dashboard overview", () => {
	test("loads and shows heading", async ({ authedPage: page }) => {
		await expect(page.getByText("Overview")).toBeVisible();
	});

	test("shows stat cards", async ({ authedPage: page }) => {
		await expect(page.getByText("Projects")).toBeVisible();
		await expect(page.getByText("Active")).toBeVisible();
		await expect(page.getByText(/Runners? Online/)).toBeVisible();
	});

	test("has Create a Project button", async ({ authedPage: page }) => {
		await expect(
			page.getByRole("link", { name: /create a project/i }),
		).toBeVisible();
	});
});

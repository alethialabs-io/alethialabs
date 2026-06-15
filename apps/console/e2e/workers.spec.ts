// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { test, expect } from "./fixtures/auth";

test.describe("Workers page", () => {
	test("loads with heading", async ({ authedPage: page }) => {
		await page.goto("/dashboard/workers");
		await expect(page.getByText("Workers")).toBeVisible();
	});
});

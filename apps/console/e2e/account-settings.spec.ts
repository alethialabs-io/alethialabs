// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { test, expect } from "./fixtures/auth";

test.describe("Account settings dialog", () => {
	test("opens from the sidebar account menu and shows the user email", async ({
		authedPage: page,
	}) => {
		// Open the account popover (three-dot), then the gear → Account Settings dialog.
		await page.getByRole("button", { name: /account menu/i }).click();
		await page.getByRole("button", { name: /account settings/i }).click();

		const dialog = page.getByRole("dialog");
		await expect(
			dialog.getByRole("heading", { name: /account settings/i }),
		).toBeVisible();
		await expect(dialog.getByText(/@/)).toBeVisible();
	});
});

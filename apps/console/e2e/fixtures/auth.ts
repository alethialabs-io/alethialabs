// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { test as base, type Page } from "@playwright/test";

async function login(page: Page) {
	const email = process.env.TEST_USER_EMAIL;
	const password = process.env.TEST_USER_PASSWORD;

	if (!email || !password) {
		throw new Error(
			"Set TEST_USER_EMAIL and TEST_USER_PASSWORD env vars to run E2E tests",
		);
	}

	await page.goto("/login");
	await page.getByPlaceholder(/email/i).fill(email);
	await page.getByPlaceholder(/password/i).fill(password);
	await page.getByRole("button", { name: /sign in/i }).click();
	await page.waitForURL(/\/dashboard/, { timeout: 15000 });
}

export const test = base.extend<{ authedPage: Page }>({
	authedPage: async ({ page }, use) => {
		await login(page);
		await use(page);
	},
});

export { expect } from "@playwright/test";

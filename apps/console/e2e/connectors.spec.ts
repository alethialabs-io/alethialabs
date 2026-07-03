// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// E2E for the redesigned connectors page (full-width: group-filter dropdown +
// search + card/table toggle, grouped sections). Route is /{org}/~/connectors.

import { test, expect } from "./fixtures/auth";

test.describe("Connectors page", () => {
	test("loads the connectors browser", async ({ authedPage: page, orgSlug }) => {
		await page.goto(`/${orgSlug}/~/connectors`);
		await expect(page.getByPlaceholder(/search connectors/i)).toBeVisible();
		// The group-filter Select (Radix trigger → combobox role) and a known connector.
		await expect(page.getByRole("combobox")).toBeVisible();
		await expect(page.getByText("GitHub").first()).toBeVisible();
	});

	test("search filters connectors", async ({ authedPage: page, orgSlug }) => {
		await page.goto(`/${orgSlug}/~/connectors`);
		await page.getByPlaceholder(/search connectors/i).fill("GitHub");
		await expect(page.getByText("GitHub").first()).toBeVisible();
		await expect(page.getByText("Datadog")).toHaveCount(0);
	});

	test("group dropdown narrows to a category", async ({
		authedPage: page,
		orgSlug,
	}) => {
		await page.goto(`/${orgSlug}/~/connectors`);
		await page.getByRole("combobox").click();
		await page.getByRole("option", { name: /clouds/i }).click();
		await expect(page.getByText("AWS").first()).toBeVisible();
	});

	test("toggles between card and table view", async ({
		authedPage: page,
		orgSlug,
	}) => {
		await page.goto(`/${orgSlug}/~/connectors`);
		await page.getByRole("button", { name: /table view/i }).click();
		await expect(page.getByRole("table").first()).toBeVisible();
		await page.getByRole("button", { name: /card view/i }).click();
		await expect(page.getByRole("table")).toHaveCount(0);
	});
});

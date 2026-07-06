// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
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

	// Regression: a fresh org has never attempted any cloud connection. Viewing the page eagerly
	// creates pending placeholder identities; neither those nor the background sweep may ever
	// surface a phantom "Verification failed → Re-verify" for a connection the user never made.
	test("a fresh org shows no phantom 'Verification failed' / 'Re-verify'", async ({
		authedPage: page,
		orgSlug,
	}) => {
		await page.goto(`/${orgSlug}/~/connectors`);
		await expect(page.getByPlaceholder(/search connectors/i)).toBeVisible();
		await expect(page.getByText(/verification failed/i)).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: /re-verify/i }),
		).toHaveCount(0);
	});

	// Regression: visiting the connectors page pre-creates pending placeholder cloud identities.
	// Those must NOT count as a connected cloud, so the setup guide's "Connect a cloud" stays
	// unticked (the header still reads "0 of N done") until a cloud is actually verified.
	test("visiting connectors does not falsely complete 'Connect a cloud'", async ({
		authedPage: page,
		orgSlug,
	}) => {
		// Trigger the eager placeholder creation.
		await page.goto(`/${orgSlug}/~/connectors`);
		await expect(page.getByPlaceholder(/search connectors/i)).toBeVisible();

		// Back on the overview, open the setup guide from the topbar.
		await page.goto(`/${orgSlug}`);
		await page.getByRole("button", { name: /setup guide/i }).click();
		await expect(page.getByText(/connect a cloud/i)).toBeVisible();
		// Nothing is done on a brand-new org (pre-fix, the phantom cloud made this "1 of …").
		await expect(page.getByText(/\b0 of \d+ done/i)).toBeVisible();
	});
});

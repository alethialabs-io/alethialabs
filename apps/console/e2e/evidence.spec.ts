// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// E2E smoke for the org Evidence surface. A fresh OTP org has no environments, so the page
// renders its honest zero-data state: the identity line, the filter toolbar, an empty posture
// table, and the recorded-waivers panel. Asserts the chrome + empty copy (selectors from
// components/evidence/*). Requires `pnpm dev:up` (console on :3000).

import { test, expect } from "./fixtures/auth";

test.describe("Evidence surface", () => {
	test("renders the org evidence chrome and honest empty state", async ({
		authedPage: page,
		orgSlug,
	}) => {
		await page.goto(`/${orgSlug}/~/evidence`);

		// Identity line eyebrow.
		await expect(page.getByText("Org evidence")).toBeVisible();
		// The filter toolbar's search box.
		await expect(
			page.getByPlaceholder(/Filter by project or environment/i),
		).toBeVisible();
		// The recorded-waivers panel is always present.
		await expect(page.getByText("Recorded waivers")).toBeVisible();
		// A fresh org has no environments → the table shows its empty copy.
		await expect(
			page.getByText(/No environments match these filters/i),
		).toBeVisible();
	});
});

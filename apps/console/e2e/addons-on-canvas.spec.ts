// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Add-ons moved ONTO the project canvas: the standalone `/{org}/{project}/addons` marketplace page
// and its sidebar item were retired, and add-ons are now browsed from the canvas "Add" palette and
// configured in a sheet. Requires `pnpm dev:up` (console on :3000; OTP scraped from the dev log).

import { expect, test } from "./fixtures/auth";

test.describe("Add-ons on the canvas", () => {
	test("the retired /addons page no longer renders the marketplace", async ({
		authedPage: page,
		orgSlug,
	}) => {
		await page.goto(`/${orgSlug}/no-such-project/addons`);
		await page.waitForLoadState("networkidle");

		// The old page's unique heading + copy must be gone (the route was removed → the app
		// never renders the marketplace grid here again).
		await expect(
			page.getByRole("heading", { name: "Add-ons", level: 1 }),
		).toHaveCount(0);
		await expect(
			page.getByText(/Free, open-source apps your cluster comes up with/i),
		).toHaveCount(0);
	});

	// The full on-canvas flow — open Architecture, press "a" to open the Add palette, see the
	// "Add-ons" group, select one to open the config sheet — needs a provisioned project. The
	// fresh-org auth fixture creates none, so this is left as a follow-up until the e2e harness can
	// seed a project. The unit tests (tests/components/addons/*) cover the palette group + sheet.
	test.fixme(
		"browse and configure an add-on from the Add palette",
		async () => {},
	);
});

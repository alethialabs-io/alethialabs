// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The account-settings dialog opened from the sidebar account menu's gear — the surface
// `apps/console/destructive-actions.yaml` pins for `account.delete`.
//
// Two things are asserted here that nothing else in the suite covers:
//
//   · the dialog reads the SESSION (email, provider badges, the dirty-gated Save), so a broken
//     `authClient.useSession()` shows up as a dialog full of "Not set" rather than as a green
//     render;
//   · the Delete Account button is INERT — see the note at its call site. That is a recorded
//     decision awaiting a maintainer ruling (#4273), not drift, so the spec pins the current
//     behaviour in BOTH directions: the control exists and is enabled (nobody has quietly
//     deleted it), and pressing it opens no confirmation and ends no session (nobody has
//     quietly wired it). Whichever way the ruling goes, this file moves in that PR.
//
// `console` project, not `qa`: this spec drives its own email-OTP signup through
// `fixtures/auth.ts` rather than a persona from `global-setup`. Every test here therefore costs
// one real signup, which is why there are four of them and not ten.

import { test, expect } from "./fixtures/auth";
import type { Page } from "@playwright/test";

/** Opens the account menu, then its gear, and returns the settings dialog once it is up. */
async function openAccountSettings(page: Page) {
	await page.getByRole("button", { name: /account menu/i }).click();
	await page.getByRole("button", { name: /account settings/i }).click();
	const dialog = page.getByRole("dialog");
	await expect(
		dialog.getByRole("heading", { name: /account settings/i }),
	).toBeVisible();
	return dialog;
}

test.describe("Account settings dialog", () => {
	test("opens from the sidebar account menu and shows the user email", async ({
		authedPage: page,
	}) => {
		const dialog = await openAccountSettings(page);
		await expect(dialog.getByText(/@/)).toBeVisible();

		// The email field carries a VALUE and is locked. `toBeDisabled` alone would pass just as
		// happily on an empty field, which is exactly what a session that failed to load renders.
		const email = dialog.locator("#account-email");
		await expect(email).toHaveValue(/.+@.+/);
		await expect(email).toBeDisabled();
		await expect(
			dialog.getByText(/email cannot be changed after registration/i),
		).toBeVisible();

		// At least one auth-provider badge. Located as a BADGE, not by the text "Email" — that
		// string is also two field labels in this dialog, so a text match would be true of a
		// provider row that rendered nothing at all.
		await expect(dialog.locator('[data-slot="badge"]').first()).toBeVisible();
	});

	test("Save Changes is inert until the display name is edited", async ({
		authedPage: page,
	}) => {
		const dialog = await openAccountSettings(page);
		const save = dialog.getByRole("button", { name: /save changes/i });
		// `isDirty` is the gate — an untouched form has nothing to save.
		await expect(save).toBeDisabled();
		await dialog.locator("#account-name").fill(`E2E Renamed ${Date.now()}`);
		await expect(save).toBeEnabled();
	});

	// ── the inert Delete Account button (#4273) ────────────────────────────────────────

	test("the danger zone offers Delete Account", async ({ authedPage: page }) => {
		const dialog = await openAccountSettings(page);
		const del = dialog.getByRole("button", { name: /^delete account$/i });
		await expect(del).toBeVisible();
		// Enabled, and that is deliberate: it LOOKS like a working control, which is precisely
		// why the ruling in #4273 matters and why the next test exists.
		await expect(del).toBeEnabled();
	});

	test("Delete Account is INERT — pressing it opens no confirmation and ends no session", async ({
		authedPage: page,
	}) => {
		const dialog = await openAccountSettings(page);
		const emailBefore = await dialog.locator("#account-email").inputValue();
		expect(emailBefore).toMatch(/.+@.+/);

		const del = dialog.getByRole("button", { name: /^delete account$/i });
		// Proves the control was really there to press, so the negative half below cannot be
		// satisfied by a button that never rendered.
		await expect(del).toBeEnabled();
		await del.click();

		// The confirmation shapes are matched by their PRIMITIVE (`alert-dialog-content` /
		// role=alertdialog), never by role=dialog: the account-settings dialog is itself a
		// role=dialog and its own copy contains "permanently deleted", so either of those would
		// match the surface under test and report a confirmation that does not exist.
		await expect(
			page.locator('[data-slot="alert-dialog-content"], [role="alertdialog"]'),
		).toHaveCount(0, { timeout: 3_000 });
		await expect(
			dialog.getByRole("heading", { name: /account settings/i }),
		).toBeVisible();
		await expect(dialog.locator("#account-email")).toHaveValue(emailBefore);

		// And the ACCOUNT survives — the half a count-zero assertion can never reach. A reload
		// still finds an authenticated console rather than a bounce to /login.
		await page.reload();
		await expect(page).not.toHaveURL(/\/login/);
		await expect(page.getByRole("button", { name: /account menu/i })).toBeVisible();
	});
});

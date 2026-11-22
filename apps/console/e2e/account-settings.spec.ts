// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The account-settings dialog opened from the sidebar account menu's gear — the surface
// `apps/console/destructive-actions.yaml` pins for `account.delete`.
//
// Two things are asserted here that nothing else in the suite covers:
//
//   · the dialog reads the SESSION (email, provider badges, the dirty-gated Save), so a broken
//     session read (`useViewer()`) shows up as a dialog full of "Not set" rather than as a green
//     render;
//   · "Delete account" SCHEDULES the account's deletion 14 days out behind a TYPED confirmation (the
//     maintainer's decision: an automatic erasure after a grace period; lib/privacy/self-deletion.ts).
//     So the spec proves both halves: the control asks first, the confirm button stays disabled
//     until the address is typed, and Cancel leaves the account and its session alone; confirming
//     signs the account out everywhere, which is what makes "sign in again to cancel" true.
//
// Confirming is safe here and nowhere else: every test signs up its own throwaway account, so the
// deletion it schedules is of a user no other test uses. `audit/destructive.spec.ts` only ever
// cancels, and the production pass never opens this control at all (`prod-qa: skip`).
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

	// ── Delete account: scheduled, 14 days out, behind a typed confirmation ───────────────────

	test("Delete account asks first with a typed confirmation, and Cancel deletes nothing and ends no session", async ({
		authedPage: page,
	}) => {
		const dialog = await openAccountSettings(page);
		const emailBefore = await dialog.locator("#account-email").inputValue();
		expect(emailBefore).toMatch(/.+@.+/);

		// The copy states the grace period, and how to cancel.
		await expect(dialog.getByText(/runs 14 days after you confirm/i)).toBeVisible();

		await dialog.getByRole("button", { name: /^delete account$/i }).click();

		// Matched by the alert-dialog PRIMITIVE, never by role=dialog: the settings dialog is
		// itself a role=dialog, so a role=dialog match could report the surface under test as
		// the confirmation.
		const confirmation = page.locator('[data-slot="alert-dialog-content"], [role="alertdialog"]').first();
		await expect(confirmation).toBeVisible();
		await expect(confirmation).toContainText(/delete your account\?/i);
		await expect(confirmation).toContainText(/deleted in 14 days/i);
		// Typed: the destructive button is disabled until the address is typed.
		const schedule = confirmation.getByRole("button", { name: /schedule deletion/i });
		await expect(schedule).toBeDisabled();

		await confirmation.getByRole("button", { name: /^cancel$/i }).click();
		await expect(confirmation).toBeHidden();

		// And the ACCOUNT survives: a reload still finds an authenticated console.
		await page.reload();
		await expect(page).not.toHaveURL(/\/login/);
		await expect(page.getByRole("button", { name: /account menu/i })).toBeVisible();
	});

	test("confirming schedules the deletion and signs the account out everywhere", async ({
		authedPage: page,
	}) => {
		const dialog = await openAccountSettings(page);
		const email = await dialog.locator("#account-email").inputValue();
		await dialog.getByRole("button", { name: /^delete account$/i }).click();
		const confirmation = page.locator('[data-slot="alert-dialog-content"], [role="alertdialog"]').first();
		await expect(confirmation).toBeVisible({ timeout: 15_000 });
		await confirmation.getByRole("textbox").fill(email);
		await confirmation.getByRole("button", { name: /schedule deletion/i }).click();

		// Every session was revoked: the browser lands on sign-in, and a reload stays there.
		await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
		await page.goto("/dashboard");
		await expect(page).toHaveURL(/\/login/);
	});
});

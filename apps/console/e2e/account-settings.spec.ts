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
//   · "Request deletion" OPENS AN ERASURE REQUEST AND DELETES NOTHING (#4273, ruled 2026-09-18) —
//     see the note at its call site. So the spec proves both halves: the control asks first and
//     Cancel leaves no trace, and confirming opens a request with a `DSR-` reference while the
//     account and its session survive. A second confirmation returns the SAME reference rather
//     than opening a second case. If the erasure executor (#4854) ever lands behind this button,
//     the "session survives" assertion is the one that has to move, and it will fail first.
//
// Confirming is safe here and nowhere else: every test signs up its own throwaway account, so the
// request it opens is about a user no other test uses. `audit/destructive.spec.ts` only ever
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

	// ── Request deletion: an erasure REQUEST, never a deletion (#4273) ─────────────────────────

	test("Request deletion asks first, and Cancel opens nothing and ends no session", async ({
		authedPage: page,
	}) => {
		const dialog = await openAccountSettings(page);
		const emailBefore = await dialog.locator("#account-email").inputValue();
		expect(emailBefore).toMatch(/.+@.+/);

		// The copy promises a request, not a deletion. The old copy said "permanently deleted",
		// which is the claim the ruling forbids while nothing is deleted.
		await expect(dialog.getByText(/opens an erasure request/i)).toBeVisible();
		await expect(dialog.getByText(/permanently deleted/i)).toHaveCount(0);

		await dialog.getByRole("button", { name: /^request deletion$/i }).click();

		// Matched by the alert-dialog PRIMITIVE, never by role=dialog: the settings dialog is
		// itself a role=dialog, so a role=dialog match could report the surface under test as
		// the confirmation.
		const confirmation = page.locator('[data-slot="alert-dialog-content"], [role="alertdialog"]').first();
		await expect(confirmation).toBeVisible();
		await expect(confirmation).toContainText(/request deletion of your account\?/i);
		await expect(confirmation).toContainText(emailBefore);
		await expect(confirmation).toContainText(/nothing is deleted now/i);
		await expect(confirmation.getByRole("button", { name: /open erasure request/i })).toBeVisible();

		await confirmation.getByRole("button", { name: /^cancel$/i }).click();
		await expect(confirmation).toBeHidden();
		await expect(page.getByText(/DSR-[0-9A-F]{8}/)).toHaveCount(0);

		// And the ACCOUNT survives: a reload still finds an authenticated console.
		await page.reload();
		await expect(page).not.toHaveURL(/\/login/);
		await expect(page.getByRole("button", { name: /account menu/i })).toBeVisible();
	});

	test("confirming opens ONE erasure request with a reference, and the account survives it", async ({
		authedPage: page,
	}) => {
		/** Opens the settings, presses Request deletion, confirms, and returns the toast's reference. */
		async function confirmRequest(expected: RegExp): Promise<string> {
			const dialog = await openAccountSettings(page);
			await dialog.getByRole("button", { name: /^request deletion$/i }).click();
			const confirmation = page.locator('[data-slot="alert-dialog-content"], [role="alertdialog"]').first();
			await confirmation.getByRole("button", { name: /open erasure request/i }).click();
			const toast = page.getByText(expected).first();
			await expect(toast).toBeVisible({ timeout: 15_000 });
			const reference = (await toast.textContent())?.match(/DSR-[0-9A-F]{8}/)?.[0];
			expect(reference, "the toast should quote the request's DSR- reference").toBeTruthy();
			return reference ?? "";
		}

		const first = await confirmRequest(/erasure request DSR-[0-9A-F]{8} opened\. nothing has been deleted yet/i);

		// The request is about THIS account and deleted nothing: the session is intact.
		await page.reload();
		await expect(page).not.toHaveURL(/\/login/);
		await expect(page.getByRole("button", { name: /account menu/i })).toBeVisible();

		// A second press while the first is open returns the SAME case, not a second one.
		const second = await confirmRequest(/you already have an open erasure request \(DSR-[0-9A-F]{8}\)/i);
		expect(second).toBe(first);
	});
});

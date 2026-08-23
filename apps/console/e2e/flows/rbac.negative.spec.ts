// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// RBAC — negative permission paths for a reduced-perm invited member.
//
// The `member` persona (an invited, non-owner member of the Pro `team` org) is NOT provisioned yet,
// so every test here is skipped via `test.skip(!process.env.HAVE_MEMBER, …)` and enumerated in the
// domain catalog. When the persona lands, drop HAVE_MEMBER=1 and these assert the server-side PDP
// (requireAccessAdmin / owner-only) denials the UI otherwise renders optimistically.

import { test, expect } from "../fixtures/qa";

const HAVE_MEMBER = !!process.env.HAVE_MEMBER;

test.describe("RBAC — member permission denials", () => {
	test.skip(!HAVE_MEMBER, "member persona pending");

	test("a member can view the members list but cannot invite", async ({ member }) => {
		await member.page.goto(`/${member.orgSlug}/~/settings/members`);
		await expect(member.page).not.toHaveURL(/\/login/);
		await expect(member.page.getByText("Seats").first()).toBeVisible({ timeout: 15_000 });
		// A member either has no Invite affordance or the server rejects the invitation.
		await member.page.getByRole("button", { name: /invite member/i }).click();
		// Expect an authorization error toast rather than a sent invitation.
		await expect(member.page.getByText(/not authorized|permission|forbidden/i)).toBeVisible();
	});

	test("a member cannot change another member's role", async ({ member }) => {
		await member.page.goto(`/${member.orgSlug}/~/settings/members`);
		await expect(member.page.getByText("Seats").first()).toBeVisible({ timeout: 15_000 });
		const roleSelect = member.page.getByRole("combobox", { name: "Role" }).first();
		await roleSelect.click();
		await member.page.getByRole("option", { name: /viewer/i }).click();
		await expect(member.page.getByText(/not authorized|permission|forbidden/i)).toBeVisible();
	});

	test("a member cannot remove another member", async ({ member }) => {
		await member.page.goto(`/${member.orgSlug}/~/settings/members`);
		await expect(member.page.getByText("Seats").first()).toBeVisible({ timeout: 15_000 });
		await member.page.getByRole("button", { name: "Manage" }).first().click();
		await member.page.getByRole("menuitem", { name: /remove from organization/i }).click();
		await expect(member.page.getByText(/not authorized|permission|forbidden/i)).toBeVisible();
	});

	test("a member cannot delete the organization", async ({ member }) => {
		await member.page.goto(`/${member.orgSlug}/~/settings/general`);
		await expect(member.page.getByRole("heading", { name: "Danger zone" })).toBeVisible({
			timeout: 15_000,
		});
		await member.page.getByRole("button", { name: /^Delete$/ }).click();
		const dialog = member.page.getByRole("alertdialog");
		await dialog.getByRole("button", { name: /delete organization/i }).click();
		// Deletion must fail — the org stays and an error surfaces.
		await expect(member.page.getByText(/not authorized|permission|forbidden/i)).toBeVisible();
		await expect(member.page).not.toHaveURL(/\/dashboard$/);
	});
});

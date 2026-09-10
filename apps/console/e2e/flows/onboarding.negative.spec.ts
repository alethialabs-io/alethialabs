// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Onboarding domain — negatives: login of an unknown email, invalid email format, a wrong
// OTP code, a reserved / blank org slug, blank-name validation in both the onboarding wizard
// and the create-org sheet, an invitation accepted from the WRONG account, and a malformed
// CLI login link. Real fresh signups where a code/onboarding is needed.

import { test, expect } from "../fixtures/qa";
import { pendingInvitationId } from "../helpers/db";
import { logCursor, waitForOtp } from "../helpers/otp";
import { organizationApi } from "../helpers/personas";
import type { Page } from "@playwright/test";

/** Email-OTP sign-in with a longer OTP wait (busy dev server logs the code late). */
async function otpSignIn(page: Page, email: string, mode: "signup" | "login"): Promise<void> {
	const cursor = await logCursor();
	await page.goto(`/${mode}`);
	await page.getByRole("button", { name: /continue with email/i }).click();
	await page.locator("#email").fill(email);
	await page.getByRole("button", { name: /continue with email/i }).click();
	const code = await waitForOtp(cursor, { timeoutMs: 150_000 });
	await page.locator("input[data-input-otp]").first().fill(code);
}

/** A unique, never-registered email so a login attempt genuinely hits the no-account branch. */
function unknownEmail(): string {
	return `e2e-noacct-${Date.now()}-${Math.floor(Math.random() * 1e4)}@alethia.test`;
}

/** A unique, valid signup email for onboarding-reaching negatives. */
function freshEmail(tag: string): string {
	return `e2e-neg-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e4)}@alethia.test`;
}

/** Drives /signup through the email step only, returning at the 6-digit code entry. */
async function signupToCodeStep(page: Page, email: string): Promise<void> {
	await page.goto("/signup");
	await page.getByRole("button", { name: /continue with email/i }).click();
	await page.locator("#email").fill(email);
	await page.getByRole("button", { name: /continue with email/i }).click();
	await expect(page.getByRole("heading", { name: /enter your code/i })).toBeVisible({
		timeout: 15_000,
	});
}

// ── /login gating ────────────────────────────────────────────────────────────────

test.describe("Onboarding negatives — login gating", () => {
	test("login with an unknown email shows the no-account screen (no silent signup)", async ({
		page,
	}) => {
		await page.goto("/login");
		await page.getByRole("button", { name: /continue with email/i }).click();
		await page.locator("#email").fill(unknownEmail());
		await page.getByRole("button", { name: /continue with email/i }).click();
		await expect(page.getByRole("heading", { name: /no account for this email/i })).toBeVisible({
			timeout: 15_000,
		});
		await expect(page.getByRole("button", { name: /create an account/i })).toBeVisible();
	});

	test("an invalid email format does not advance past the email step", async ({ page }) => {
		await page.goto("/signup");
		await page.getByRole("button", { name: /continue with email/i }).click();
		await page.locator("#email").fill("not-an-email");
		await page.getByRole("button", { name: /continue with email/i }).click();
		// HTML5 email validation blocks submit → still on the email step, never a code screen.
		await expect(page.getByRole("heading", { name: /sign up with email/i })).toBeVisible();
		await expect(page.getByRole("heading", { name: /enter your code/i })).toBeHidden();
	});
});

// ── OTP code errors ──────────────────────────────────────────────────────────────

test.describe("Onboarding negatives — OTP code", () => {
	test("a wrong 6-digit code is rejected with an inline error", async ({ page }) => {
		await signupToCodeStep(page, freshEmail("wrongotp"));
		await page.locator("input[data-input-otp]").first().fill("000000");
		await expect(page.getByText(/that code didn.t work/i)).toBeVisible({ timeout: 15_000 });
		// Still on the code step (not signed in / not onboarded).
		await expect(page).not.toHaveURL(/\/onboarding/);
	});

	test("the code step lets you go back to change the email", async ({ page }) => {
		await signupToCodeStep(page, freshEmail("changeemail"));
		await page.getByRole("button", { name: /use a different email/i }).click();
		await expect(page.getByRole("heading", { name: /sign up with email/i })).toBeVisible();
	});
});

// ── Onboarding wizard validation ───────────────────────────────────────────────────

test.describe("Onboarding negatives — wizard validation", () => {
	/** Fresh signup landed on /onboarding, ready for wizard-level assertions. */
	async function toOnboarding(page: Page, tag: string): Promise<void> {
		// A slow OTP (helper waits up to 60s) can exceed the 30s default — give headroom.
		test.setTimeout(180_000);
		await otpSignIn(page, freshEmail(tag), "signup");
		await page.waitForURL(/\/onboarding/, { timeout: 30_000 });
		await expect(page.getByRole("heading", { name: /create your organization/i })).toBeVisible({
			timeout: 15_000,
		});
	}

	test("a reserved slug is rejected", async ({ page }) => {
		await toOnboarding(page, "reserved");
		await page.locator("#org-name").fill(`E2E Reserved ${Date.now()}`);
		await page.getByRole("button", { name: /customize url/i }).click();
		// "docs" is a reserved console/sibling segment (lib/routing RESERVED_SLUGS).
		const slugBox = page.locator('input[autocomplete="off"]').last();
		await slugBox.fill("docs");
		await page.getByRole("button", { name: /create organization/i }).click();
		await expect(page.getByText(/reserved/i)).toBeVisible({ timeout: 15_000 });
		await expect(page).toHaveURL(/\/onboarding/);
	});

	test("a blank org name keeps the create button disabled", async ({ page }) => {
		await toOnboarding(page, "blankname");
		await page.locator("#org-name").fill("");
		await expect(page.getByRole("button", { name: /create organization/i })).toBeDisabled();
	});
});

// ── Create-org sheet validation ────────────────────────────────────────────────────

test.describe("Onboarding negatives — create-org sheet", () => {
	test("continuing with a blank team name surfaces a validation error", async ({ owner }) => {
		await owner.page.goto(`/${owner.orgSlug}`);
		await owner.page.getByRole("button", { name: /switch organization/i }).click();
		await owner.page.getByRole("button", { name: /create organization/i }).click();
		await expect(
			owner.page.getByRole("heading", { level: 1, name: /create a team/i }),
		).toBeVisible();
		// Leave the name blank and submit the name step.
		await owner.page.getByRole("button", { name: /^continue$/i }).click();
		await expect(owner.page.getByText(/give your team a name/i)).toBeVisible({ timeout: 15_000 });
	});
});

// ── Invitation accept, refused ─────────────────────────────────────────────────────

test.describe("Onboarding negatives — invitation accept", () => {
	test("an invitation addressed to somebody else is refused for the wrong account", async ({
		team,
		owner,
	}) => {
		test.setTimeout(120_000);
		const orgId = team.orgId;
		expect(orgId, "the ownerTeam persona has no resolved org id — global-setup did not finish").toBeTruthy();
		if (!orgId) return;

		// A real, pending invitation addressed to a THIRD party — not to the account that will try
		// to accept it. Sent through the same endpoint the console's invite dialog calls; landing on
		// the org first re-syncs the session's active organization, which `invite-member` reads.
		const invitee = `e2e-neg-wrongacct-${Date.now()}-${Math.floor(Math.random() * 1e4)}@alethia.test`;
		await team.page.goto(`/${team.orgSlug}`, { waitUntil: "domcontentloaded" });
		const invited = await organizationApi(team.page, "invite-member", {
			email: invitee,
			role: "member",
			organizationId: orgId,
		});
		expect(invited.status, `invite-member answered ${invited.status}: ${invited.text}`).toBeLessThan(400);
		const token = await pendingInvitationId(orgId, invitee);
		expect(token, `no pending invitation row for ${invitee} after a ${invited.status}`).toBeTruthy();

		// ownerHobby is a real, signed-in account — and NOT the invitee. The screen renders (the
		// token exists), so the refusal has to come from the accept itself.
		await owner.page.goto(`/invites/accept?token=${token}`);
		await owner.page.getByRole("button", { name: /accept invitation/i }).click();

		// The inline error is what the accept UNIQUELY produces here — an absence assertion would
		// be equally true of a button that never fired. Located as the live region, NOT by matching
		// the word "invitation": this card's heading, body and buttons are all full of that word,
		// so a text match would be true of a page where nothing happened.
		//
		// `p[role="alert"]`, not `getByRole("alert")`: Next mounts its own route announcer as an
		// always-present, always-empty `<div role="alert" aria-live="assertive">`, so the role on
		// its own resolves to two elements and the assertion dies in strict mode before it can say
		// anything about the refusal (measured on run 34469855618).
		const refusal = owner.page.locator('p[role="alert"]');
		await expect(refusal).toBeVisible({ timeout: 20_000 });
		// Non-empty, so an empty live region can never stand in for a message. The exact WORDING is
		// deliberately not pinned: it is Better Auth's own copy for an address mismatch ("You are
		// not the recipient of the invitation"), falling back to this page's "Couldn't accept this
		// invitation." — pinning a dependency's string would make a library bump a red gate, and
		// what matters here is that a refusal was shown at all.
		await expect(refusal).toHaveText(/\S/);
		// A successful accept pushes /dashboard, so staying put is the second half of the same fact.
		await expect(owner.page).toHaveURL(/\/invites\/accept/);

		// And the invitation is untouched: still pending, so the real invitee can still use it.
		expect(
			await pendingInvitationId(orgId, invitee),
			"a refused accept must leave the invitation pending for the address it was sent to",
		).toBe(token);
	});
});

// ── The CLI hand-off, refused ──────────────────────────────────────────────────────

test.describe("Onboarding negatives — the CLI hand-off", () => {
	test("a malformed CLI login link errors and offers no Approve", async ({ owner }) => {
		// Neither code parses (lib/auth/cli-device-code.ts: a UUID device_code, a CONSONANT-only
		// XXXX-XXXX user_code), so the page must never put an unreadable string in front of the
		// operator as "the code to compare".
		await owner.page.goto("/cli/login?device_code=not-a-uuid&user_code=nope");
		await expect(owner.page.getByText(/authentication failed/i)).toBeVisible({ timeout: 20_000 });
		await expect(
			owner.page.getByText(/not a valid CLI login request/i),
		).toBeVisible();
		// The approval gesture is the whole security boundary (#2213), so it is ABSENT rather than
		// disabled on a request the screen could not describe.
		await expect(owner.page.getByRole("button", { name: /^approve$/i })).toHaveCount(0);
	});

	test("a CLI login link with no codes at all errors the same way", async ({ owner }) => {
		await owner.page.goto("/cli/login");
		await expect(owner.page.getByText(/authentication failed/i)).toBeVisible({ timeout: 20_000 });
		await expect(owner.page.getByRole("button", { name: /^approve$/i })).toHaveCount(0);
	});
});

// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// E2E auth via the real email-OTP flow (password auth was removed). A unique email per run
// keeps each run deterministic (fresh signup → onboarding → a new org). The 6-digit code is
// scraped from the dev console log (see helpers/otp). Selectors come from
// components/auth/auth-form.tsx and components/auth/onboarding-form.tsx.
//
// Requires `pnpm dev:up` running (console on :3000, SES unconfigured so the OTP is logged).

import { test as base, expect, type Page } from "@playwright/test";
import { logCursor, waitForOtp } from "../helpers/otp";

/**
 * Signs up a brand-new account via email-OTP and completes onboarding on the free (Hobby)
 * plan, landing on the org's overview. Returns the resolved org slug.
 */
export async function signUpWithOtp(page: Page): Promise<{ email: string; orgSlug: string }> {
	const email = process.env.TEST_USER_EMAIL ?? `e2e-${Date.now()}@alethia.test`;
	const cursor = await logCursor(); // ignore any earlier code in the log

	await page.goto("/signup");

	// Step 1 (provider grid) → choose email. Step 2 → enter the email and request the code.
	await page.getByRole("button", { name: /continue with email/i }).click();
	await page.locator("#email").fill(email);
	await page.getByRole("button", { name: /continue with email/i }).click();

	// Step 3: the 6-box input-otp auto-submits on completion. input-otp exposes a single
	// numeric input that accepts the whole code.
	const code = await waitForOtp(cursor);
	// input-otp renders one hidden numeric input (data-input-otp) that drives the 6 slots and
	// auto-submits via onComplete once all digits are present.
	await page.locator("input[data-input-otp]").first().fill(code);

	// New accounts land on /onboarding (gated on onboardingCompletedAt). Pick Hobby, name the
	// org, submit → the org overview at /{slug}.
	await page.waitForURL(/\/onboarding/, { timeout: 20_000 });
	await page.getByRole("textbox", { name: /organization|team|name/i }).first().fill("E2E Org");
	// The Hobby (free) tile, then continue.
	await page.getByText(/hobby/i).first().click();
	await page.getByRole("button", { name: /continue|get started|finish|create/i }).first().click();

	// Onboarding hands off to /{slug} (not /onboarding, not /signup).
	await page.waitForURL((url) => /^\/[^/]+$/.test(url.pathname) && url.pathname !== "/signup", {
		timeout: 20_000,
	});
	const orgSlug = page.url().replace(/^https?:\/\/[^/]+\//, "").replace(/[/?#].*$/, "");
	return { email, orgSlug };
}

/** Fixtures: an authenticated page already inside its org, plus the resolved org slug. */
export const test = base.extend<{ authedPage: Page; orgSlug: string }>({
	orgSlug: async ({ page }, use) => {
		const { orgSlug } = await signUpWithOtp(page);
		await use(orgSlug);
	},
	authedPage: async ({ page, orgSlug }, use) => {
		expect(orgSlug).toBeTruthy();
		await use(page);
	},
});

export { expect } from "@playwright/test";

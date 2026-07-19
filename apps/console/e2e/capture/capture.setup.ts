// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Signs in as the SEEDED demo owner (not a fresh signup) via the real email-OTP
// flow, then persists the authenticated session (with theme forced to dark) for
// the shots project to reuse. The OTP is scraped from the console stdout log.

import { expect, test as setup } from "@playwright/test";
import { CAPTURE_STATE } from "../../playwright.capture.config";
import { logCursor, waitForOtp } from "../helpers/otp";

const EMAIL = process.env.CAPTURE_EMAIL ?? "dana@acme.example";

setup("sign in as the seeded demo owner", async ({ page }) => {
	const cursor = await logCursor();
	await page.goto("/login", { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(800);

	// Step 1 is a provider grid with a "Continue with email" button that reveals the
	// email step; step 2 has the #email input + a submit disabled until filled. Reveal
	// the email field if we're on step 1, then submit via Enter (the form's onSubmit)
	// to avoid the duplicate "Continue with email" button ambiguity.
	const emailInput = page.locator("#email");
	if (!(await emailInput.isVisible().catch(() => false))) {
		await page.getByRole("button", { name: /continue with email/i }).click({ force: true, timeout: 15_000 });
	}
	await emailInput.waitFor({ state: "visible", timeout: 15_000 });
	await emailInput.fill(EMAIL);
	await emailInput.press("Enter");

	const code = await waitForOtp(cursor, { email: EMAIL });
	await page.locator("input[data-input-otp]").first().fill(code);

	// An already-onboarded user lands straight on /{orgSlug}.
	await page.waitForURL(
		(url) => /^\/[^/]+$/.test(url.pathname) && !/^\/(login|signup|onboarding)$/.test(url.pathname),
		{ timeout: 30_000 },
	);
	const orgSlug = new URL(page.url()).pathname.replace(/^\//, "").replace(/\/.*$/, "");
	expect(orgSlug, "resolved the seeded org slug").toBeTruthy();

	// Force dark theme (brand is dark-first; the video reads best on dark) and persist it.
	await page.evaluate(() => localStorage.setItem("theme", "dark"));
	await page.context().storageState({ path: CAPTURE_STATE });
	console.log(`[capture] signed in as ${EMAIL} → /${orgSlug}`);
});

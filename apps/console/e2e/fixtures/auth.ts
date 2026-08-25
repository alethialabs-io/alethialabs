// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Hermetic e2e auth via the real email-OTP flow (password auth was removed). A unique email per
// run keeps each run deterministic: a fresh signup → onboarding → a brand-new org. The 6-digit
// code is scraped from the console's stdout log (see helpers/otp) — no real email, no OAuth, no
// external service. Selectors come from components/auth/auth-form.tsx + onboarding-form.tsx.
//
// Requires the console running with SES unconfigured so the OTP is logged (local: `pnpm dev:up`;
// CI: the e2e-browser job boots `next start` and tees stdout to $DEV_CONSOLE_LOG).

import { ACCEPTANCE_LABELS } from "@repo/legal/documents";
import { CONSENT_LABELS } from "@repo/privacy/consent";
import path from "node:path";
import { test as base, expect, type Page } from "@playwright/test";
import { logCursor, waitForOtp } from "../helpers/otp";

/** Reusable persona storage state produced by auth.setup.ts (gitignored). */
export const STORAGE_STATE = path.join(__dirname, "..", ".auth", "persona.json");

/**
 * Signs a brand-new account in via email-OTP and completes onboarding on the free (Hobby) plan,
 * landing on the new org's overview. Returns the account email + resolved org slug. This is the
 * shared building block for both the hero spec (which drives it live as step 1 of the demo) and
 * the storageState setup.
 */
export async function signUpWithOtp(page: Page): Promise<{ email: string; orgSlug: string }> {
	const email =
		process.env.TEST_USER_EMAIL ??
		`e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@alethia.test`;
	// Capture the log size BEFORE requesting a code so we never read an earlier run's code.
	const cursor = await logCursor();

	await page.goto("/signup");
	// A fresh browser must make an explicit privacy choice before the product journey.
	// Keep E2E telemetry off and persist the same first-party decision a user would make.
	// Located by the exported constant, not a literal: this locator broke silently when the button
	// was relabelled for consent v2, and a 5s timeout in the hero path was the first anyone knew.
	const rejectTelemetry = page.getByRole("button", {
		name: CONSENT_LABELS.reject,
		exact: true,
	});
	await rejectTelemetry.waitFor({ state: "visible", timeout: 5_000 });
	await rejectTelemetry.click();

	// Step 1 (provider grid) → choose email. Step 2 → enter the email + request the code. Both
	// steps surface exactly one "Continue with email" button, so the sequence is unambiguous.
	await page.getByRole("button", { name: /continue with email/i }).click();
	await page.locator("#email").fill(email);
	await page.getByRole("button", { name: /continue with email/i }).click();

	// Step 3: the 6-box input-otp exposes one hidden numeric input (data-input-otp) that drives the
	// slots and auto-submits via onComplete once all six digits are present.
	const code = await waitForOtp(cursor, { email });
	await page.locator("input[data-input-otp]").first().fill(code);

	// New accounts land on /onboarding (gated on onboardingCompletedAt). Hobby (community) is the
	// default-selected plan; name the org and create it → the app drops us on /{slug}.
	// A unique org name → unique slug, so repeat runs against a shared DB (and a setup + hero run
	// in one invocation) never collide on the globally-unique org slug.
	const orgName = `E2E ${email.split("@")[0]}`;
	await page.waitForURL(/\/onboarding/, { timeout: 30_000 });
	await page.locator("#org-name").fill(orgName);
	await page.getByRole("button", { name: /create organization/i }).click();

	// The clickwrap gate (#2372). Every route under (private) redirects here until the account has
	// accepted the CURRENT Terms, so a brand-new account meets it between onboarding and the org —
	// and the fixture walks it exactly as a person would rather than seeding an acceptance row,
	// which would leave the gate itself never exercised in a browser.
	//
	// Located by the exported constants, not literals, for the reason CONSENT_LABELS records above.
	await acceptCurrentTerms(page);

	// Onboarding hands off to /{slug} — a single path segment that is NOT one of the waypoints on
	// the way there. All four exclusions are load-bearing, and two of them were learned the hard
	// way: `/accept-terms` (the gate) and `/dashboard` (where accepting hands off to) are both
	// single-segment paths, so a matcher that only excluded the auth routes resolved "accept-terms"
	// or "dashboard" as the org slug — and the run then failed three steps later at `connect a
	// cloud`, nowhere near the cause.
	await page.waitForURL(
		(url) =>
			/^\/[^/]+$/.test(url.pathname) &&
			!/^\/(signup|onboarding|login|accept-terms|dashboard)$/.test(url.pathname),
		{ timeout: 30_000 },
	);
	const orgSlug = new URL(page.url()).pathname.replace(/^\//, "").replace(/\/.*$/, "");
	expect(orgSlug, "resolved a non-empty org slug after onboarding").toBeTruthy();
	return { email, orgSlug };
}

/**
 * Walks the post-auth clickwrap if it is showing, and returns once it is not.
 *
 * Tolerant of NOT being there on purpose: the gate only fires for an account that has not accepted
 * the current Terms, so a run against a pre-accepted persona must not hang waiting for a form that
 * will never appear. It waits briefly, and proceeds if the gate did not come up.
 */
async function acceptCurrentTerms(page: Page): Promise<void> {
	const accept = page.getByRole("button", { name: ACCEPTANCE_LABELS.submit });
	try {
		await accept.waitFor({ state: "visible", timeout: 15_000 });
	} catch {
		return; // already accepted — nothing to walk
	}
	// The box starts UNTICKED and the button is inert until it is ticked; that is the whole point of
	// a clickwrap, so the fixture asserts it rather than clicking straight through.
	await expect(accept).toBeDisabled();
	await page
		.getByText(new RegExp(ACCEPTANCE_LABELS.checkboxPrefix, "i"))
		.first()
		.click();
	await expect(accept).toBeEnabled();
	await accept.click();
	await expect(accept).toBeHidden({ timeout: 30_000 });
}

/** Fixtures: an authenticated page already inside its fresh org, plus the resolved org slug. */
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

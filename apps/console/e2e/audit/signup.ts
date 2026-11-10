// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A brand-new account and organisation, for the audit specs that must not touch the persona's own.
//
// Moved out of `permissions.spec.ts` unchanged (T7 builds its owner and its operator with it) when
// `behaviour.spec.ts` (#6116) needed an organisation of its own too: family B seeds rows into every
// list it can reach, and `routes.spec.ts` keeps the persona's organisation EMPTY for T5. Two copies
// of a retry walk this careful would drift the first time the signup flow changes.

import type { Page } from "@playwright/test";
import { signUpWithOtp } from "../fixtures/auth";

/**
 * Signs an account up, retrying the whole walk — WITH A FRESH ADDRESS EACH TIME.
 *
 * `signUpWithOtp` waits 5s for the consent banner and 30s for the OTP, and on a contended runner
 * the first of those is genuinely tight; `e2e/global-setup.ts` wraps every persona in the same
 * shape for the same reason ("transient recompile 500s, slow OTP"). A T7 persona that fails to be
 * born takes the whole predicate with it. `label` prefixes the retry log with the spec asking.
 *
 * THE ADDRESS MUST CHANGE PER ATTEMPT, and this is not tidiness. `signUpWithOtp` creates the
 * account at OTP verification and then still has to walk onboarding, the clickwrap and the org
 * hand-off. A failure in any of those — precisely the transient case the retry exists for — leaves
 * a REAL account behind. Retried on the same address the flow is a SIGN-IN, `/onboarding` never
 * appears, and the fixture's `waitForURL(/\/onboarding/)` times out after 30s. Every later attempt
 * is then guaranteed to fail, and the run spends two 35s sleeps and two 30s timeouts proving it
 * inside a 180s test budget. So the caller gets back the address that actually worked.
 */
export async function signUpWithRetry(
	page: Page,
	emailFor: (attempt: number) => string,
	attempts = 3,
	label = "audit/T7",
): Promise<{ email: string; orgSlug: string }> {
	let last: unknown;
	for (let i = 1; i <= attempts; i++) {
		const email = emailFor(i);
		try {
			const { orgSlug } = await withTestEmail(email, () => signUpWithOtp(page));
			return { email, orgSlug };
		} catch (err) {
			last = err;
			const why = err instanceof Error ? err.message : String(err);
			// WHERE it stopped, not just that it did. A bare "locator timed out" sends the reader to
			// the locator; the URL and the first line of the page say whether the walk was on the
			// signup form at all — which is how the "already signed in, so /signup redirected"
			// case tells itself apart from "the consent button was renamed".
			const where = await page
				.evaluate(() => `${location.pathname} :: ${document.body.innerText.trim().slice(0, 160)}`)
				.catch(() => "(page unreadable)");
			console.warn(`[${label}] signup ${email} attempt ${i}/${attempts}: ${why}\n    at ${where}`);
			await page.context().clearCookies();
			// 35s, not 2s. Better Auth caps OTP issuance at 5 sends / 60s per IP
			// (`lib/config/auth.ts`), and a retry inside that window gets "Too many requests" and
			// burns an attempt without ever asking for a code. Measured: three attempts, 2s apart,
			// all three refused by the rate limiter.
			await page.waitForTimeout(35_000);
		}
	}
	throw last;
}

/**
 * Runs `fn` with `signUpWithOtp` pointed at `email`.
 *
 * `fixtures/auth.ts` reads `TEST_USER_EMAIL` and otherwise invents an address. Setting it around
 * the call is how an audit spec reuses the whole vetted signup walk — consent, OTP, onboarding, the
 * clickwrap — for an address it has to choose, instead of writing a second copy of it that would
 * drift the first time the gate changes.
 */
export async function withTestEmail<T>(email: string, fn: () => Promise<T>): Promise<T> {
	const prior = process.env.TEST_USER_EMAIL;
	process.env.TEST_USER_EMAIL = email;
	try {
		return await fn();
	} finally {
		if (prior === undefined) delete process.env.TEST_USER_EMAIL;
		else process.env.TEST_USER_EMAIL = prior;
	}
}

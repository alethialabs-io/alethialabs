// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The one reading of STRIPE_SECRET_KEY. Its own module, with no imports, so the two consumers that
// must agree — `config.ts` (which builds the Stripe client's config) and `eligibility.ts` (the
// test-mode market seam) — share it without either depending on the other, and a test that mocks
// one of them cannot quietly give the other a different reading. Server-only.

/**
 * THE one reading of `STRIPE_SECRET_KEY`, trimmed; "" when unset or blank.
 *
 * Every consumer of the key asks this, so they cannot disagree about what it is (#5443). Before,
 * `testModeMarketOpen` trimmed the value and the Stripe client did not: a key carried with a
 * trailing newline — the shape a secret store or a `$(cat key)` export leaves behind — was judged
 * a TEST key by the market seam while the client was built from a different string. The seam's
 * safety argument is "the key that decides the waiver is the key that would move the money", and
 * that only holds while both read the same value.
 */
export function stripeSecretKey(
	env: Readonly<Record<string, string | undefined>> = process.env,
): string {
	return env.STRIPE_SECRET_KEY?.trim() ?? "";
}

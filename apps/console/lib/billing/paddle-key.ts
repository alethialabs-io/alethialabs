// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The one reading of PADDLE_API_KEY. Its own module, with no imports, so every consumer that must
// agree — `paddle/config.ts` (which builds the Paddle client's config), the provider seam
// (`provider/select.ts`, which asks whether Paddle is configured) and the market-eligibility seam
// (which will judge sandbox vs live) — shares it without depending on each other. Mirrors
// `stripe-key.ts` (#5443): the key that decides "this is a sandbox" must be the key that would move
// the money, and that only holds while both read the same value. Server-only.

/** The two Paddle environments, as `PADDLE_ENVIRONMENT` names them. */
export type PaddleEnvironment = "sandbox" | "live";

/** The API-key prefix each Paddle environment issues. A key is only ever valid for its own. */
export const PADDLE_API_KEY_PREFIX: { readonly [E in PaddleEnvironment]: string } = {
	sandbox: "pdl_sdbx_apikey_",
	live: "pdl_live_apikey_",
};

/**
 * THE one reading of `PADDLE_API_KEY`, trimmed; "" when unset or blank. A key carried with a
 * trailing newline (what a secret store or a `$(cat key)` export leaves behind) reads the same here
 * as everywhere else.
 */
export function paddleApiKey(
	env: Readonly<Record<string, string | undefined>> = process.env,
): string {
	return env.PADDLE_API_KEY?.trim() ?? "";
}

/**
 * The environment a Paddle API key belongs to, from its prefix; null for "" or a string that is not
 * a Paddle API key at all. The key, not `PADDLE_ENVIRONMENT`, is what decides where money moves, so
 * this is what a mode question must ask.
 */
export function paddleKeyEnvironment(key: string): PaddleEnvironment | null {
	if (key.startsWith(PADDLE_API_KEY_PREFIX.sandbox)) return "sandbox";
	if (key.startsWith(PADDLE_API_KEY_PREFIX.live)) return "live";
	return null;
}

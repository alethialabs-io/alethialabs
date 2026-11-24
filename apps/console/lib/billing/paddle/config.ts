// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Paddle Billing configuration. Entirely optional: when PADDLE_API_KEY is unset the Paddle provider
// is simply not configured (the seam — lib/billing/provider/select.ts — then never routes a sale to
// it). When it IS set, every value must agree on ONE environment or the config refuses to load:
//
//   PADDLE_ENVIRONMENT              sandbox | live
//   PADDLE_API_KEY                  pdl_sdbx_apikey_… (sandbox) | pdl_live_apikey_… (live)
//   NEXT_PUBLIC_PADDLE_CLIENT_TOKEN test_… (sandbox)            | live_… (live)
//   PADDLE_WEBHOOK_SECRET           the notification destination's secret key
//
// A sandbox key under PADDLE_ENVIRONMENT=live (or the reverse) is a deploy mistake that would either
// send real customers to a sandbox checkout or point a test deploy at real money, so it THROWS rather
// than guessing. Catalog ids (prices `pri_…`, products `pro_…`) come from `scripts/paddle-setup.ts`
// (L2). Server-only — never import from a client component (the client token is the one value that
// may cross, as a plain string).

import { z } from "zod";
import {
	PADDLE_API_KEY_PREFIX,
	type PaddleEnvironment,
	paddleApiKey,
	paddleKeyEnvironment,
} from "@/lib/billing/paddle-key";

/** The client-token prefix each Paddle environment issues (Paddle.js `Initialize({ token })`). */
export const PADDLE_CLIENT_TOKEN_PREFIX: { readonly [E in PaddleEnvironment]: string } = {
	sandbox: "test_",
	live: "live_",
};

const priceId = z.string().regex(/^pri_[a-z0-9]+$/, "must be a Paddle price id (pri_…)");
const productId = z.string().regex(/^pro_[a-z0-9]+$/, "must be a Paddle product id (pro_…)");

/** An env value that may be blank: "" and whitespace read as unset. */
function optional<T extends z.ZodType>(inner: T) {
	return z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), inner.optional());
}

const schema = z
	.object({
		environment: z.enum(["sandbox", "live"]),
		apiKey: z.string().min(1),
		webhookSecret: z.string().min(1),
		clientToken: z.string().min(1),
		/** Paddle price ids per self-serve product. `team` (Pro) is the one plan that must exist. */
		prices: z.object({
			team: priceId,
			enterprise: optional(priceId),
			aiPlus: optional(priceId),
			aiMax: optional(priceId),
		}),
		/**
		 * Paddle product ids that NON-CATALOG items reference: the runner-minute overage charge (L5) and
		 * one-off AI credit packs. Optional until those lanes land.
		 */
		products: z.object({
			runnerMinutes: optional(productId),
			aiCredits: optional(productId),
		}),
		/** Absolute base URL for checkout return links. */
		appUrl: z.string().url(),
	})
	.superRefine((c, ctx) => {
		const keyEnv = paddleKeyEnvironment(c.apiKey);
		if (keyEnv !== c.environment) {
			ctx.addIssue({
				code: "custom",
				path: ["apiKey"],
				message: `PADDLE_API_KEY must start with ${PADDLE_API_KEY_PREFIX[c.environment]} for PADDLE_ENVIRONMENT=${c.environment} (got a ${keyEnv ?? "non-Paddle"} key)`,
			});
		}
		if (!c.clientToken.startsWith(PADDLE_CLIENT_TOKEN_PREFIX[c.environment])) {
			ctx.addIssue({
				code: "custom",
				path: ["clientToken"],
				message: `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN must start with ${PADDLE_CLIENT_TOKEN_PREFIX[c.environment]} for PADDLE_ENVIRONMENT=${c.environment}`,
			});
		}
	});

export type PaddleConfig = z.infer<typeof schema>;

/** Whether Paddle is wired on this instance. A blank key is not a key. */
export function isPaddleConfigured(
	env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
	return paddleApiKey(env) !== "";
}

/**
 * Parses and validates the Paddle config from `env` — pure, uncached (tests call this directly).
 * Throws with every problem named, never a secret value: zod's messages above name prefixes only.
 */
export function parsePaddleConfig(
	env: Readonly<Record<string, string | undefined>> = process.env,
): PaddleConfig {
	const parsed = schema.safeParse({
		environment: env.PADDLE_ENVIRONMENT?.trim(),
		apiKey: paddleApiKey(env),
		webhookSecret: env.PADDLE_WEBHOOK_SECRET?.trim(),
		clientToken: env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN?.trim(),
		prices: {
			team: env.PADDLE_PRICE_TEAM?.trim(),
			enterprise: env.PADDLE_PRICE_ENTERPRISE,
			aiPlus: env.PADDLE_PRICE_AI_PLUS,
			aiMax: env.PADDLE_PRICE_AI_MAX,
		},
		products: {
			runnerMinutes: env.PADDLE_PRODUCT_RUNNER_MINUTES,
			aiCredits: env.PADDLE_PRODUCT_AI_CREDITS,
		},
		appUrl: env.NEXT_PUBLIC_APP_URL ?? env.BETTER_AUTH_URL,
	});
	if (!parsed.success) {
		const problems = parsed.error.issues
			.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
			.join("; ");
		throw new Error(`Invalid Paddle config: ${problems}`);
	}
	return parsed.data;
}

let cached: PaddleConfig | null = null;

/** The validated Paddle config for this process (cached). Throws if Paddle is used but misconfigured. */
export function getPaddleConfig(): PaddleConfig {
	if (cached) return cached;
	cached = parsePaddleConfig();
	return cached;
}

/** Forgets the cached config. Tests only: a fresh process has none. */
export function resetPaddleConfigCache(): void {
	cached = null;
}

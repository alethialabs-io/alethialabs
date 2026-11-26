// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The environment variable names of the Paddle catalog ids and the Paddle.js client token: ONE
// definition, read by the console (lib/billing/paddle/config.ts) and printed by the catalog tool
// (scripts/paddle-setup.ts, scripts/paddle-check.ts). The tool names a price or product by its SLOT
// here, never by a name of its own, so the name it prints is the name the console reads by
// construction. Before this file the tool printed PADDLE_PRICE_PRO while the console read
// PADDLE_PRICE_TEAM, and printed credit-pack price names nothing read.
//
// No imports and no secrets: safe for a script, a test or a client bundle to import.

/** The catalog prices the console reads, by its own config key (`PaddleConfig["prices"]`). */
export type PaddlePriceSlot = "team" | "enterprise" | "aiPlus" | "aiMax";

/** The products non-catalog lines are charged against, by config key (`PaddleConfig["products"]`). */
export type PaddleProductSlot = "runnerMinutes" | "aiCredits";

/** The env var holding each catalog price id (`pri_…`). */
export const PADDLE_PRICE_ENV: { readonly [S in PaddlePriceSlot]: string } = {
	team: "PADDLE_PRICE_TEAM",
	enterprise: "PADDLE_PRICE_ENTERPRISE",
	aiPlus: "PADDLE_PRICE_AI_PLUS",
	aiMax: "PADDLE_PRICE_AI_MAX",
};

/** The env var holding each product id (`pro_…`). */
export const PADDLE_PRODUCT_ENV: { readonly [S in PaddleProductSlot]: string } = {
	runnerMinutes: "PADDLE_PRODUCT_RUNNER_MINUTES",
	aiCredits: "PADDLE_PRODUCT_AI_CREDITS",
};

/** The env var holding the public Paddle.js client-side token (`test_…` / `live_…`). */
export const PADDLE_CLIENT_TOKEN_ENV = "NEXT_PUBLIC_PADDLE_CLIENT_TOKEN";

/** The env var holding the notification destination's endpoint secret key. */
export const PADDLE_WEBHOOK_SECRET_ENV = "PADDLE_WEBHOOK_SECRET";

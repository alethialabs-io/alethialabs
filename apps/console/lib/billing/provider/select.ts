// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Which payment provider a billing call goes to. Two questions, two answers (see ./types.ts):
//
//   salesProvider()       — where a NEW sale goes: `BILLING_PROVIDER`, validated, FAILING CLOSED.
//                           Unset, blank or unknown ⇒ null ⇒ no provider ⇒ billing is not configured.
//                           There is deliberately no "Stripe if Stripe keys are present" fallback:
//                           which merchant sells to a customer is a legal fact (seller of record), not
//                           something to infer from which secrets happen to be in the environment.
//                           Every deploy that sells sets it explicitly (deploy assembly + examples).
//   providerForOrg(row)   — where an EXISTING subscription lives: the row's own `billing_provider`,
//                           so flipping `BILLING_PROVIDER` never strands a subscriber elsewhere.
//
// No imports beyond the key readers, the closed provider list and the adapters, so lib/billing/config.ts
// can build `isBillingConfigured` on top of this without a cycle (the Paddle adapter imports only
// lib/billing/paddle/* and types from lib/billing/config).

import { z } from "zod";
import { paddleApiKey } from "@/lib/billing/paddle-key";
import { createPaddleProvider } from "@/lib/billing/paddle/provider";
import { stripeSecretKey } from "@/lib/billing/stripe-key";
import { BILLING_PROVIDERS, type BillingProviderId } from "@/lib/db/schema/billing-provider";
import type { BillingProvider } from "@/lib/billing/provider/types";

type Env = Readonly<Record<string, string | undefined>>;

const salesProviderSchema = z.enum(BILLING_PROVIDERS);

/**
 * The instance's sales provider, from `BILLING_PROVIDER` (trimmed, exact lower-case match); null when
 * unset, blank or not one of `BILLING_PROVIDERS`. Fails closed: null means NO provider, never a guess.
 */
export function salesProvider(env: Env = process.env): BillingProviderId | null {
	const parsed = salesProviderSchema.safeParse(env.BILLING_PROVIDER?.trim());
	return parsed.success ? parsed.data : null;
}

/** The billing-row columns that decide which provider an org's existing subscriptions live with. */
export interface ProviderRoutingRow {
	billingProvider: BillingProviderId | null;
	stripeSubscriptionId: string | null;
	aiStripeSubscriptionId: string | null;
	paddleSubscriptionId: string | null;
	aiPaddleSubscriptionId: string | null;
}

/**
 * The provider an org's billing goes to: the row's `billing_provider` when set; otherwise the provider
 * whose subscription id the row holds (today's Stripe writers predate the column and leave it NULL, so
 * a Stripe subscriber must still route to Stripe after `BILLING_PROVIDER` changes); otherwise — no row,
 * or a row with no subscription — the instance's sales provider. Null when none of those answers.
 */
export function providerForOrg(
	row: ProviderRoutingRow | null,
	env: Env = process.env,
): BillingProviderId | null {
	if (row?.billingProvider) return row.billingProvider;
	if (row && (row.stripeSubscriptionId != null || row.aiStripeSubscriptionId != null)) return "stripe";
	// Unreachable under organization_billing_paddle_sub_is_paddle (a Paddle id requires the column),
	// stated anyway so this function does not depend on a constraint it cannot see.
	if (row && (row.paddleSubscriptionId != null || row.aiPaddleSubscriptionId != null)) return "paddle";
	return salesProvider(env);
}

/** Whether the provider's secret key is present on this instance (a blank key is not a key). */
export function isProviderKeyConfigured(id: BillingProviderId, env: Env = process.env): boolean {
	switch (id) {
		case "stripe":
			return stripeSecretKey(env) !== "";
		case "paddle":
			return paddleApiKey(env) !== "";
	}
}

/** Whether new sales can be taken: a sales provider is selected AND its key is configured. */
export function isSalesProviderConfigured(env: Env = process.env): boolean {
	const id = salesProvider(env);
	return id !== null && isProviderKeyConfigured(id, env);
}

/**
 * The adapter factory per provider. Null until that provider's adapter lands (Stripe: the thin
 * wrapper over billing.ts). Paddle's carries the webhook today (L3); its purchase and plan methods
 * arrive with L4 and throw until then. A mapped type over
 * `BillingProviderId`, so adding a provider to the closed list fails to compile until it has an entry.
 */
const ADAPTERS: { readonly [K in BillingProviderId]: (() => BillingProvider) | null } = {
	stripe: null,
	paddle: createPaddleProvider,
};

/** The adapter for a provider id, or null while that provider has no adapter on this build. */
export function providerById(id: BillingProviderId): BillingProvider | null {
	const factory = ADAPTERS[id];
	return factory ? factory() : null;
}

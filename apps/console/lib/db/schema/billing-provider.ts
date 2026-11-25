// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The payment providers a billing record, a webhook event, an order or a usage charge can belong to.
// One closed list, declared here with no imports so every schema file that stores a provider — and
// the provider seam (lib/billing/provider/) that selects one — reads the same literals. Stored as
// text + a CHECK constraint (not a pg enum): enums.ts is owned elsewhere, and adding a value to a
// CHECK is one migration with no `ALTER TYPE … ADD VALUE` transaction caveat.

/** Every payment provider the console can route a sale or a subscription through. */
export const BILLING_PROVIDERS = ["stripe", "paddle"] as const;

/** One of `BILLING_PROVIDERS`. */
export type BillingProviderId = (typeof BILLING_PROVIDERS)[number];

/**
 * `'stripe', 'paddle'` for a CHECK constraint's IN list. Built from the closed literal list above,
 * never from input, so `sql.raw` over it cannot carry anything but these words.
 */
export function billingProviderSqlList(): string {
	return BILLING_PROVIDERS.map((v) => `'${v}'`).join(", ");
}

/** Whether `value` is one of `BILLING_PROVIDERS` — a type guard, so no cast is needed to narrow. */
export function isBillingProviderId(value: unknown): value is BillingProviderId {
	return typeof value === "string" && BILLING_PROVIDERS.some((p) => p === value);
}

// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The length caps on what a customer types at the create-a-team checkout (#5445), shared by the
// forms that collect it (components/billing/billing-checkout-form.tsx, components/org/create-org-sheet.tsx)
// and the server action that stores it (`saveNewOrgSetupDetails`, through
// lib/billing/pending-org-setup.ts). ONE set of numbers: when the forms accepted more than the server
// did, a value the form let through was refused by the server after the charge, and the details were
// not kept.

import { ORG_SLUG_MAX_LENGTH } from "@repo/org-slug";

/** The maximum length of each checkout billing field, in characters. */
export const BILLING_FIELD_CAPS = {
	name: 200,
	line1: 200,
	line2: 200,
	city: 200,
	state: 200,
	postalCode: 40,
	country: 2,
	taxValue: 64,
} as const;

/**
 * The maximum length of an organization slug — the org-slug rule's own (`ORG_SLUG_MAX_LENGTH`,
 * @repo/org-slug), which the create-a-team form's slugifier already cuts to and its
 * schema also checks.
 */
export const ORG_SLUG_MAX = ORG_SLUG_MAX_LENGTH;

/** The sentence for a field longer than its cap. */
export function tooLongMessage(max: number): string {
	return `Use at most ${max} characters.`;
}

// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The server-side record of a paid create-a-team setup (#5445), shared by the server actions that
// read it and the client code that writes it.
//
// The create-a-team sheet charges FIRST and creates the organization after. The organization is
// created through better-auth's `/organization/create`, and the only place a value can be written in
// the SAME insert as the organization row is its `metadata`. So the create carries the id of the
// subscription it is being created for, under the key below. That makes "which organization did this
// user already create for this subscription?" a question the SERVER can answer — the create response
// can be lost (a reload, a dropped connection) after the row was committed, and a resume must find
// that organization rather than make a second one.
//
// The marker is written by the customer's own browser, so it is a claim, not a proof. It is only
// ever read together with two checks the server makes itself: the subscription was minted for this
// user (`created_by` on the Stripe subscription), and the user is an OWNER member of the organization
// carrying the marker. A marker naming someone else's subscription therefore finds nothing.

/** The organization-metadata key that names the subscription an organization was created for. */
export const NEW_ORG_SUBSCRIPTION_KEY = "newOrgSubscriptionId";

/**
 * The subscription id an organization's metadata says it was created for, or null. Tolerant: the
 * metadata column is free-form JSON text, and anything that is not an object carrying a string under
 * the key reads as "none".
 */
export function newOrgSubscriptionIdOf(metadata: string | null): string | null {
	if (!metadata) return null;
	try {
		const parsed: unknown = JSON.parse(metadata);
		if (typeof parsed !== "object" || parsed === null) return null;
		const value: unknown = Reflect.get(parsed, NEW_ORG_SUBSCRIPTION_KEY);
		return typeof value === "string" && value ? value : null;
	} catch {
		return null;
	}
}

/**
 * What the server knows about one new-org subscription, read from Stripe and the database — never
 * from the browser's copy. `resolveNewOrgSetup` answers it; the create-a-team sheet resumes from it.
 */
export interface NewOrgSetupState {
	subscriptionId: string;
	customerId: string;
	/** Stripe says the first invoice was paid (active, trialing or past_due). */
	paid: boolean;
	/** The organization created for this subscription, if one exists and the caller owns it. */
	org: { id: string; slug: string } | null;
	/** The subscription's metadata names `org` — the link step's Stripe writes landed. */
	linked: boolean;
	/** The org's billing row carries a complete payer declaration (capacity, and the attestation when one is required). */
	declared: boolean;
	/** The team name the subscription was opened for (the Stripe customer's name). */
	name: string;
	currency: string;
}

/** Stripe subscription statuses that mean the charge went through. */
export const PAID_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set([
	"active",
	"trialing",
	"past_due",
]);

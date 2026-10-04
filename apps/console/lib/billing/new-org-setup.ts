// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The marker that ties an organization to the paid create-a-team setup it was created for (#5445),
// shared by the server code that reads it and the client code that sends it.
//
// The create-a-team sheet charges FIRST and creates the organization after, through better-auth's
// `/organization/create`. The only place a value can be written in the SAME insert as the organization
// row is its `metadata`, so the create carries the subscription id under `NEW_ORG_SUBSCRIPTION_KEY`.
// That lets the server find the organization again when the create response is lost (a reload, a
// dropped connection) after the row was committed.
//
// The browser sends the subscription id; it does NOT get to make the claim stick. The organization
// plugin's `beforeCreateOrganization` hook (ee/src/new-org-setup-hooks.ts, via
// lib/billing/pending-org-setup.ts) keeps the key only when the creating user owns the server-side
// setup record for that subscription, and stamps `NEW_ORG_CREATED_BY_KEY` with that user's id in the
// same insert. Any value a client sends under either key is otherwise removed. So a marked organization
// is proof of who created it for which charge — which is what lets the resume adopt it, and repair
// its owner membership when better-auth's separate member insert never landed.

import type { NewOrgPlanState } from "@/lib/billing/new-org-plan-state";
import type { PendingOrgSetupBilling } from "@/types/jsonb.types";

/** The organization-metadata key that names the subscription an organization was created for. */
export const NEW_ORG_SUBSCRIPTION_KEY = "newOrgSubscriptionId";

/** The organization-metadata key the SERVER stamps with the creating user's id beside the marker. */
export const NEW_ORG_CREATED_BY_KEY = "newOrgCreatedBy";

/** The refusal code for a create naming a setup that already has its organization. */
export const NEW_ORG_SETUP_ORG_EXISTS_CODE = "NEW_ORG_SETUP_ORG_EXISTS";

/**
 * The refusal code for a create naming a setup another create is claiming right now (two tabs, or a
 * retry racing the first attempt). Retryable: the retry finds the organization the other one made.
 */
export const NEW_ORG_SETUP_IN_PROGRESS_CODE = "NEW_ORG_SETUP_IN_PROGRESS";

/**
 * The subscription id an organization's metadata says it was created for, or null. Tolerant: the
 * metadata column is free-form JSON text (better-auth hands hooks a parsed object), and anything that
 * is not an object carrying a string under the key reads as "none".
 */
export function newOrgSubscriptionIdOf(metadata: unknown): string | null {
	return stringKeyOf(metadata, NEW_ORG_SUBSCRIPTION_KEY);
}

/** The creating user the server stamped beside the marker, or null. Same tolerance as above. */
export function newOrgCreatedByOf(metadata: unknown): string | null {
	return stringKeyOf(metadata, NEW_ORG_CREATED_BY_KEY);
}

/** A non-empty string under `key` in metadata given as JSON text or as an object, else null. */
function stringKeyOf(metadata: unknown, key: string): string | null {
	let parsed: unknown = metadata;
	if (typeof metadata === "string") {
		try {
			parsed = JSON.parse(metadata);
		} catch {
			return null;
		}
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const value: unknown = Reflect.get(parsed, key);
	return typeof value === "string" && value ? value : null;
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
	/**
	 * What the finished setup may say about the plan (#5522), decided from the subscription and its first
	 * invoice's payments as the server read them — the sheet shows it instead of assuming "active".
	 */
	planState: NewOrgPlanState;
	/** The organization created for this subscription, if one exists and the caller owns it. */
	org: { id: string; slug: string } | null;
	/** The subscription's metadata names `org` — the link step's Stripe writes landed. */
	linked: boolean;
	/** The org's billing row carries a complete payer declaration (capacity, and the attestation when one is required). */
	declared: boolean;
	/** The team name the subscription was opened for. */
	name: string;
	/** The slug the customer chose (or the org's, once it exists) — what a recovered setup creates at. */
	slug: string;
	/**
	 * The billing details typed at checkout, kept server-side — the tax id and the "use as the team's
	 * address" choice a recovered setup restores. Null for a setup recorded before the checkout saved
	 * them ahead of the charge, or one backfilled from Stripe for a subscription that predates the record.
	 */
	billing: PendingOrgSetupBilling | null;
	currency: string;
}

/** Stripe subscription statuses that mean the charge went through. */
export const PAID_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set([
	"active",
	"trialing",
	"past_due",
]);

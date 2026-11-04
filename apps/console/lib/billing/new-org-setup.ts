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

import { LEGAL_ENTITY } from "@repo/legal/entity";
import type { NewOrgPlanState } from "@/lib/billing/new-org-plan-state";
import type { PendingOrgSetupBilling } from "@/types/jsonb.types";
import type { OpenPaymentHoldState, PaymentHoldReleaseReason } from "@/lib/db/schema";

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
	/** Stripe's hosted page to complete an `action_needed` payment; null otherwise, and while `hold` is set. */
	paymentUrl: string | null;
	/**
	 * The OPEN payment hold that names this subscription (ADR 0002 §5.6): its state, and the sentence the
	 * customer is shown about it (§5.5). Null when no hold is open. `resolveNewOrgSetup` and
	 * `findUnfinishedNewOrgSetup` set it on every state they return.
	 */
	hold?: { state: OpenPaymentHoldState; notice: string } | null;
	/**
	 * Set when this subscription has ENDED (`canceled` or `incomplete_expired`) and no open hold names it
	 * (ADR 0002 §5.6 "The lookup reports an ended setup"): the sentence the link would refuse it with
	 * (`endedSetupRead`, `endedSetupClause`). Null otherwise — an open hold is reported in `hold` instead.
	 */
	ended: { clause: string } | null;
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

// The sentences for an ENDED subscription with no open hold (ADR 0002 §5.5, §5.6). The link refuses such
// a subscription with one of them, and the resume lookup reports it with the same one, so both read them
// from here. The free-plan sentence is appended once, only when a team exists for the setup.
const LINK_REFUSED_NOT_CHARGED =
	"This checkout was closed before its payment completed, so it was not linked to a team. It was not charged.";
const LINK_REFUSED_UNCONFIRMED = `This checkout was closed, and we could not confirm whether its payment went through, so it was not linked to a team. Contact support at ${LEGAL_ENTITY.supportEmail} with the time of the payment.`;
const LINK_REFUSED_ALERT_RAISED = " We have raised an alert.";
/** §5.5's `released(refunded)` clause, for an ended subscription a hold refunded in full. */
const LINK_REFUSED_REFUNDED =
	"This checkout was closed, so it was not linked to a team. An earlier payment was refunded in full; it can take 5–10 business days to reach you.";
const LINK_REFUSED_FREE_PLAN = " A team already created for it stays on the Hobby plan.";

/** What is known of an ended subscription's money: refunded by a hold, never charged, or not proven either. */
export type EndedSetupRead = "refunded" | "not_charged" | "unconfirmed";

/**
 * Reads what an ended subscription's money did (ADR 0002 §5.6): `refunded` when the newest released hold
 * on it released as `refunded` or `already_refunded`; otherwise `not_charged` when its payments read
 * `not_charged`; otherwise `unconfirmed` — money may have moved, or the read failed.
 */
export function endedSetupRead(
	releasedReason: PaymentHoldReleaseReason | null,
	planState: NewOrgPlanState,
): EndedSetupRead {
	if (releasedReason === "refunded" || releasedReason === "already_refunded") return "refunded";
	return planState === "not_charged" ? "not_charged" : "unconfirmed";
}

/**
 * The sentence for an ended subscription (ADR 0002 §5.5): the clause for `read`, with "We have raised an
 * alert." only for `unconfirmed` and only when an alert reached a channel (I8), and the free-plan sentence
 * only when a team exists for the setup.
 */
export function endedSetupClause(
	read: EndedSetupRead,
	opts: { alerted: boolean; teamExists: boolean },
): string {
	const head =
		read === "refunded"
			? LINK_REFUSED_REFUNDED
			: read === "not_charged"
				? LINK_REFUSED_NOT_CHARGED
				: `${LINK_REFUSED_UNCONFIRMED}${opts.alerted ? LINK_REFUSED_ALERT_RAISED : ""}`;
	return `${head}${opts.teamExists ? LINK_REFUSED_FREE_PLAN : ""}`;
}

// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Per-seat billing: keep a Pro org's Stripe subscription quantity in step with its
// billable membership. Invites land AFTER checkout (the create-org sheet), so the seat
// count grows over time — `syncOrgSeats` is called from the org plugin's member
// lifecycle hooks (afterAddMember / afterRemoveMember / afterUpdateMemberRole) to
// reconcile the quantity (prorated). Billable = every active member except `viewer`
// (viewers are free, matching the plan catalog). Hosted-only; no-op without Stripe.

import { and, count, eq, ne } from "drizzle-orm";
import { isStripeConfigured } from "@/lib/billing/config";
import { getOrgBilling } from "@/lib/billing/queries";
import { getStripe } from "@/lib/billing/stripe";
import { getServiceDb } from "@/lib/db";
import { member } from "@/lib/db/schema";

/** Count of an org's billable seats: active members whose role isn't `viewer`. */
export async function countBillableSeats(orgId: string): Promise<number> {
	const [row] = await getServiceDb()
		.select({ n: count() })
		.from(member)
		.where(
			and(
				eq(member.organizationId, orgId),
				eq(member.status, "active"),
				ne(member.role, "viewer"),
			),
		);
	return row?.n ?? 0;
}

/**
 * Reconciles the org's live subscription quantity with its billable seat count
 * (prorated). No-op unless Stripe is configured and the org has a live (active /
 * trialing) subscription. Touches only the flat plan item — never the metered
 * runner-minutes item — and skips the Stripe write when the quantity already matches.
 */
export async function syncOrgSeats(orgId: string): Promise<void> {
	if (!isStripeConfigured()) return;
	const billing = await getOrgBilling(orgId);
	if (!billing?.stripeSubscriptionId) return;
	if (billing.status !== "active" && billing.status !== "trialing") return;

	const seats = Math.max(1, await countBillableSeats(orgId));
	const stripe = getStripe();
	const sub = await stripe.subscriptions.retrieve(billing.stripeSubscriptionId);
	// The seat item is the licensed (non-metered) line; runner-minutes is metered.
	const flat = sub.items.data.find(
		(i) => i.price.recurring?.usage_type !== "metered",
	);
	if (!flat || flat.quantity === seats) return;

	await stripe.subscriptions.update(sub.id, {
		items: [{ id: flat.id, quantity: seats }],
		proration_behavior: "create_prorations",
	});
}

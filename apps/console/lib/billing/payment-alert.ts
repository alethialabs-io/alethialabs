// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The operator alert for a customer payment that needs a person (#5463, #5489): a subscription the
// purchase flow cancelled, or was replacing, is not proven settled — money was taken and the automatic
// refund failed, what was taken cannot be read, its invoice could not be voided, or its cancel could
// not be confirmed. Since #5714 it also covers two create-a-team cases, chosen by `context`: a
// subscription the link refused beside the team's other live plan, and one whose unfinished setup was
// closed after it ended without its payment being proven unmoved. A log line alone tells nobody; this also raises `system.platform.payment_needs_support`
// on the platform operator's org (`ALETHIA_PLATFORM_ALERT_ORG_ID`, the same routing the loop supervisor
// uses), where an alert rule fans it out to the bound channels. When that variable is unset (a
// self-hosted deployment with no operator org) only the log line is written.
//
// It answers whether the alert reached a channel (#5489), because the customer is told "we have
// raised an alert" only when that is true: the variable alone proves nothing — the operator org also
// needs an enabled rule for the event bound to a channel, and a rule's throttle can drop a repeat.

import "server-only";
import { emitAlertEvent } from "@/lib/alerts/emit";

/**
 * What the alert's subject is to the flow that raises it — the clause the summary uses to say how the
 * subscription got here (ADR 0002 §10 S1 item 7). The default, `purchase_flow`, is the original text.
 *   - `purchase_flow`: a subscription the purchase flow cancelled, or was replacing;
 *   - `link_refused`: a create-a-team subscription the link refused, because the team already has
 *     another live plan — it is live and unlinked, and keeps renewing until a person acts;
 *   - `setup_closed`: a create-a-team subscription whose unfinished setup was closed because the
 *     subscription ended, and whose first payment is not proven unmoved.
 */
export type PaymentAlertContext = "purchase_flow" | "link_refused" | "setup_closed";

/** The summary clause for each context. */
const CONTEXT_CLAUSE: Record<PaymentAlertContext, string> = {
	purchase_flow: "which the purchase flow cancelled or was replacing",
	link_refused:
		"a create-a-team subscription the link refused because the team already has another live plan",
	setup_closed:
		"a create-a-team subscription whose unfinished setup was closed because the subscription ended",
};

/** The event key the catalog lists under Platform health. */
const PAYMENT_NEEDS_SUPPORT_EVENT = "system.platform.payment_needs_support";

/**
 * Logs, and alerts the platform operator about, a subscription whose payment needs a manual refund or
 * review — one the purchase flow cancelled (or was replacing), or, by `context`, a create-a-team one
 * the link refused or whose setup was closed. `detail` says what went wrong; the subscription is the alert's subject, so
 * a rule's throttle collapses repeats for the same one.
 *
 * Resolves true only when at least one delivery was queued to a channel bound to an enabled rule for
 * the event (`emitAlertEvent` > 0). False when `ALETHIA_PLATFORM_ALERT_ORG_ID` is unset, when no rule
 * or channel matched, when the throttle dropped it, or when emitting failed. Never throws.
 */
export async function alertPaymentNeedsSupport(input: {
	subscriptionId: string;
	customerId: string;
	paymentIntentId: string | null;
	detail: string;
	error?: unknown;
	/** Selects the summary's clause; `purchase_flow` when omitted. */
	context?: PaymentAlertContext;
}): Promise<boolean> {
	const clause = CONTEXT_CLAUSE[input.context ?? "purchase_flow"];
	const summary = `Subscription ${input.subscriptionId} (customer ${input.customerId}${
		input.paymentIntentId ? `, PaymentIntent ${input.paymentIntentId}` : ""
	}), ${clause}: ${input.detail}`;
	console.error(`[billing] payment needs support — ${summary}`, input.error ?? "");
	const orgId = process.env.ALETHIA_PLATFORM_ALERT_ORG_ID;
	if (!orgId) return false;
	try {
		const queued = await emitAlertEvent(orgId, PAYMENT_NEEDS_SUPPORT_EVENT, {
			title: "A customer payment needs manual review",
			summary,
			severity: "critical",
			resource_type: "stripe_subscription",
			resource_id: input.subscriptionId,
		});
		return queued > 0;
	} catch (err) {
		console.error(`[alerts] emit failed (${PAYMENT_NEEDS_SUPPORT_EVENT}):`, err);
		return false;
	}
}

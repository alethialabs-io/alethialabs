// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The operator alert for a customer payment that needs a person (#5463, #5489): a subscription the
// purchase flow cancelled, or was replacing, is not proven settled — money was taken and the automatic
// refund failed, what was taken cannot be read, its invoice could not be voided, or its cancel could
// not be confirmed. A log line alone tells nobody; this also raises `system.platform.payment_needs_support`
// on the platform operator's org (`ALETHIA_PLATFORM_ALERT_ORG_ID`, the same routing the loop supervisor
// uses), where an alert rule fans it out to the bound channels. When that variable is unset (a
// self-hosted deployment with no operator org) only the log line is written.
//
// It answers whether the alert reached a channel (#5489), because the customer is told "we have
// raised an alert" only when that is true: the variable alone proves nothing — the operator org also
// needs an enabled rule for the event bound to a channel, and a rule's throttle can drop a repeat.

import "server-only";
import { emitAlertEvent } from "@/lib/alerts/emit";

/** The event key the catalog lists under Platform health. */
const PAYMENT_NEEDS_SUPPORT_EVENT = "system.platform.payment_needs_support";

/**
 * Logs, and alerts the platform operator about, a subscription the purchase flow cancelled (or was
 * replacing) whose payment needs a manual refund or review. `detail` says what went wrong; the subscription is the alert's subject, so
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
}): Promise<boolean> {
	const summary = `Subscription ${input.subscriptionId} (customer ${input.customerId}${
		input.paymentIntentId ? `, PaymentIntent ${input.paymentIntentId}` : ""
	}), which the purchase flow cancelled or was replacing: ${input.detail}`;
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

// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The platform operator's alert for a billing finding that needs a person, with the caller's own
// title and summary (ADR 0004 D6, advisory 10). `alertPaymentNeedsSupport` (payment-alert.ts) always
// says the subscription is one "which the purchase flow cancelled or was replacing"; this one says what
// the caller passes, so a finding that is not that (two live org plans, ADR 0004 D6) is not mislabelled.
//
// It is a `server-only` module and deliberately carries no "use server" directive. An exported function
// of a "use server" file is a server action that any client can call, and calling this one pages the
// operator.

import "server-only";
import { emitAlertEvent } from "@/lib/alerts/emit";

/** The event the platform operator's alert rules route (`alertPaymentNeedsSupport` raises the same one). */
export const OPERATOR_ALERT_EVENT = "system.platform.payment_needs_support";

/** What an operator alert is about: its resource, so a rule's throttle collapses repeats for the same one. */
interface OperatorAlertSubject {
	type: "stripe_subscription" | "stripe_customer" | "user";
	id: string;
}

/** One operator alert: a title, the resource it is about, and the summary a person reads. */
export interface OperatorAlert {
	title: string;
	subject: OperatorAlertSubject;
	summary: string;
}

/**
 * Logs the alert, and raises it on the platform operator's org (`ALETHIA_PLATFORM_ALERT_ORG_ID`); with
 * that variable unset only the log line is written. Resolves true only when a delivery was queued to a
 * channel (`emitAlertEvent` > 0), and false when the variable is unset, when no rule or channel matched,
 * when a throttle dropped it, or when emitting failed. Never throws.
 */
export async function alertOperator(input: OperatorAlert): Promise<boolean> {
	console.error(`[billing] operator alert — ${input.summary}`);
	const orgId = process.env.ALETHIA_PLATFORM_ALERT_ORG_ID;
	if (!orgId) return false;
	try {
		const queued = await emitAlertEvent(orgId, OPERATOR_ALERT_EVENT, {
			title: input.title,
			summary: input.summary,
			severity: "critical",
			resource_type: input.subject.type,
			resource_id: input.subject.id,
		});
		return queued > 0;
	} catch (err) {
		console.error(`[alerts] emit failed (${OPERATOR_ALERT_EVENT}):`, err);
		return false;
	}
}

// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The withdrawal acknowledgement's sender (#7339). The template is a legal text, approved by the
// maintainer's review of 2026-11-23 (#7351) — see the header of emails/withdrawal-acknowledgement.tsx.

import { formatDate, formatMoney } from "@repo/format";
import { getEmailConfig } from "@repo/email/config";
import { eq } from "drizzle-orm";
import type { ConsumerLocale } from "@repo/legal/commerce";
import { SUBJECT, WithdrawalAcknowledgementEmail } from "@/emails/withdrawal-acknowledgement";
import { alertOperator } from "@/lib/billing/operator-alert";
import { getServiceDb } from "@/lib/db";
import { user } from "@/lib/db/schema";
import { log } from "@/lib/observability/log";
import { sendGuardedEmail } from "./guard";

/** What the acknowledgement needs: the order withdrawn from and the split the server recorded. */
export interface WithdrawalAcknowledgement {
	readonly orderId: string;
	/** The consumer who placed the order — the party the acknowledgement is owed to. */
	readonly placedByUserId: string;
	readonly withdrawnAt: Date;
	readonly refundMinorUnits: number;
	readonly retainedMinorUnits: number;
	readonly currency: string;
	/**
	 * Whether the owed refund was issued at Stripe, or none was owed (`WithdrawalResult.refundIssued`).
	 * False adds the "we contact you within 14 days" sentence.
	 */
	readonly refundIssued: boolean;
	/** `withdrawalOutcome`'s `basis`, computed in {@link locale}. */
	readonly basis: string;
	/** The email's language, from the order's billing country (`consumerLocaleFor`). */
	readonly locale: ConsumerLocale;
}

/** The email address of the user who placed the order, or null. */
async function placedByEmail(userId: string): Promise<string | null> {
	const [row] = await getServiceDb()
		.select({ email: user.email })
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);
	return row?.email ?? null;
}

/**
 * Pages the platform operator that an acknowledgement owed for `ack` was not sent, so it is sent by
 * hand inside the statutory deadline. Never throws (`alertOperator` does not).
 */
async function alertUnsent(ack: WithdrawalAcknowledgement, why: string): Promise<void> {
	await alertOperator({
		title: "Withdrawal acknowledgement not sent",
		subject: { type: "user", id: ack.placedByUserId },
		summary:
			`The acknowledgement for the withdrawal from order ${ack.orderId} was NOT sent (${why}). ` +
			"It must be sent by hand, by the end of the working day (ЗЗП art. 52a).",
	});
}

/**
 * Sends the durable acknowledgement of a recorded withdrawal to the consumer who placed the order.
 *
 * NEVER THROWS. It runs after the refund moved and the withdrawal was recorded, so failing the action
 * here would tell the consumer a withdrawal failed that in fact took effect. A send that could not
 * happen is logged and pages the platform operator instead, because an unsent acknowledgement is a
 * statutory duty unmet (ЗЗП art. 52a: by the end of the working day), not a cosmetic miss — it has
 * to be found and sent by hand. Returns whether it was handed to the suppression-aware send (`sendGuardedEmail`, which itself
 * skips — with a warning — an address that hard-bounced or complained).
 */
export async function sendWithdrawalAcknowledgementEmail(
	ack: WithdrawalAcknowledgement,
): Promise<boolean> {
	try {
		const to = await placedByEmail(ack.placedByUserId);
		if (!to) {
			await alertUnsent(ack, "no email address for the consumer who placed it");
			return false;
		}
		const config = getEmailConfig();
		await sendGuardedEmail({
			from: config.from.general,
			configurationSetName: config.configSet.general,
			to,
			subject: SUBJECT[ack.locale],
			react: WithdrawalAcknowledgementEmail({
				// UTC, and said so: the acknowledgement records an instant, and a time without its zone
				// is not one.
				withdrawnAtLabel: `${formatDate(ack.withdrawnAt, "datetime", "UTC")} UTC`,
				orderReference: ack.orderId,
				refundLabel: formatMoney(ack.refundMinorUnits, ack.currency),
				retainedLabel: formatMoney(ack.retainedMinorUnits, ack.currency),
				basis: ack.basis,
				refundIssued: ack.refundIssued,
				locale: ack.locale,
			}),
			devLog: `withdrawal acknowledgement for order ${ack.orderId}`,
		});
		return true;
	} catch (err) {
		log.error(`[withdrawal-email] acknowledgement for order ${ack.orderId} not sent`, { err });
		await alertUnsent(ack, "the send failed");
		return false;
	}
}

// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button, Heading, Text } from "@react-email/components";
import { EmailLayout } from "@repo/email/components/layout";
import { primaryButton, text } from "@repo/email/components/theme";
import { BillingLegal, Callout, SummaryTable } from "./billing-shared";

export interface PaymentFailedEmailProps {
	/** Organization the subscription belongs to. */
	orgName: string;
	/** Formatted amount that failed, e.g. "$58.00". */
	amountLabel: string;
	/** When Stripe will next retry the charge, e.g. "Jul 6, 2026". */
	nextAttemptLabel?: string;
	/** Card that failed, e.g. "Visa •••• 4242". */
	cardLabel?: string;
	/** Absolute link to update the payment method. */
	billingUrl?: string;
}

export const subject = "Action needed — your Alethia payment failed";

/** Sent on invoice.payment_failed — dunning: prompt to update the card before the
 *  subscription lapses to community. */
export function PaymentFailedEmail({
	orgName,
	amountLabel,
	nextAttemptLabel,
	cardLabel,
	billingUrl = "https://alethialabs.io/settings/billing",
}: PaymentFailedEmailProps) {
	return (
		<EmailLayout
			preview="We couldn't process your payment — update your card to keep Alethia active."
			legal={<BillingLegal />}
		>
			<Text className="a-text-3" style={text.eyebrow}>
				Payment failed
			</Text>
			<Heading as="h2" className="a-text" style={text.heading}>
				We couldn&apos;t charge your card.
			</Heading>
			<Text className="a-text-2" style={text.body}>
				The latest payment for <strong>{orgName}</strong> didn&apos;t go
				through. Your plan stays active for now, but please update your payment
				method to avoid an interruption
				{nextAttemptLabel ? (
					<>
						{" "}
						— we&apos;ll retry automatically on <strong>{nextAttemptLabel}</strong>
					</>
				) : null}
				.
			</Text>

			<SummaryTable
				rows={[
					...(cardLabel ? [{ label: "Card", value: cardLabel }] : []),
					...(nextAttemptLabel
						? [{ label: "Next retry", value: nextAttemptLabel }]
						: []),
					{ label: "Amount due", value: amountLabel, strong: true },
				]}
			/>

			<Callout label="What happens next">
				We&apos;ll keep retrying automatically. If the payment can&apos;t be
				collected, the organization reverts to the free Community tier — nothing is
				deleted, and your projects and configuration stay intact.
			</Callout>

			<Button href={billingUrl} className="a-btn" style={primaryButton}>
				Update payment method →
			</Button>
		</EmailLayout>
	);
}

PaymentFailedEmail.PreviewProps = {
	orgName: "Acme Cloud",
	amountLabel: "$58.00",
	nextAttemptLabel: "Jul 6, 2026",
	cardLabel: "Visa •••• 4242",
	billingUrl: "https://alethialabs.io/settings/billing",
} satisfies PaymentFailedEmailProps;

export default PaymentFailedEmail;

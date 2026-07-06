// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button, Heading, Text } from "@react-email/components";
import { EmailLayout } from "@repo/email/components/layout";
import { primaryButton, text } from "@repo/email/components/theme";
import { BillingLegal, Callout, SummaryTable } from "./billing-shared";

export interface CreditPackReceiptEmailProps {
	/** Organization the credits were added to. */
	orgName: string;
	/** Number of AI credits purchased, e.g. 2000. */
	credits: number;
	/** Formatted amount charged, e.g. "$29.00". */
	amountLabel: string;
	/** Stripe invoice number, e.g. "ABCD-0002". */
	invoiceNumber?: string;
	/** Absolute link to the usage page. */
	usageUrl?: string;
}

/** Subject for a credit-pack purchase. */
export function subject(
	props: Pick<CreditPackReceiptEmailProps, "credits">,
): string {
	return `Your Alethia credits are ready — ${props.credits.toLocaleString("en-US")} added`;
}

/** Sent on the credit-pack invoice's payment_succeeded — confirms the one-time
 *  top-up; the compliant invoice PDF is attached by the sender. */
export function CreditPackReceiptEmail({
	orgName,
	credits = 0,
	amountLabel,
	invoiceNumber,
	usageUrl = "https://alethialabs.io/settings/usage",
}: CreditPackReceiptEmailProps) {
	const creditsLabel = credits.toLocaleString("en-US");
	return (
		<EmailLayout
			preview={`${creditsLabel} AI credits added to ${orgName}.`}
			legal={<BillingLegal />}
		>
			<Text className="a-text-3" style={text.eyebrow}>
				Credits added
			</Text>
			<Heading as="h2" className="a-text" style={text.heading}>
				Your credits are ready.
			</Heading>
			<Text className="a-text-2" style={text.body}>
				We&apos;ve added <strong>{creditsLabel}</strong> AI credits to{" "}
				<strong>{orgName}</strong>. They&apos;re available now and stack on top
				of your plan&apos;s included allowance. A PDF copy of this invoice is
				attached for your records.
			</Text>

			<SummaryTable
				rows={[
					{ label: "Credits", value: creditsLabel },
					...(invoiceNumber
						? [{ label: "Invoice", value: invoiceNumber }]
						: []),
					{ label: "Total", value: amountLabel, strong: true },
				]}
			/>

			<Callout label="How credits work">
				Purchased credits never expire and are spent only after your plan&apos;s
				monthly included allowance runs out — so you&apos;re never charged twice
				for the same usage.
			</Callout>

			<Button href={usageUrl} className="a-btn" style={primaryButton}>
				View usage →
			</Button>
		</EmailLayout>
	);
}

CreditPackReceiptEmail.PreviewProps = {
	orgName: "Acme Cloud",
	credits: 2000,
	amountLabel: "$29.00",
	invoiceNumber: "ABCD-0002",
	usageUrl: "https://alethialabs.io/settings/usage",
} satisfies CreditPackReceiptEmailProps;

export default CreditPackReceiptEmail;

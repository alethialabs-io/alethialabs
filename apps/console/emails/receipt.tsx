// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button, Heading, Text } from "@react-email/components";
import { EmailLayout } from "@repo/email/components/layout";
import { primaryButton, text } from "@repo/email/components/theme";
import { BillingLegal, Callout, SummaryTable } from "./billing-shared";

export interface ReceiptEmailProps {
	/** Organization the subscription belongs to. */
	orgName: string;
	/** Human plan label, e.g. "Pro". */
	planLabel: string;
	/** Formatted total charged, e.g. "$58.00". */
	amountLabel: string;
	/** Billing period covered, e.g. "Jul 3 – Aug 3, 2026". */
	periodLabel?: string;
	/** Card used, e.g. "Visa •••• 4242". */
	cardLabel?: string;
	/** Stripe invoice number, e.g. "ABCD-0001". */
	invoiceNumber?: string;
	/** Absolute link to the org's billing settings. */
	billingUrl?: string;
}

/** Subject line for a paid receipt. */
export function subject(props: Pick<ReceiptEmailProps, "amountLabel">): string {
	return `Your Alethia receipt — ${props.amountLabel}`;
}

/** Sent on invoice.payment_succeeded — a branded receipt; the compliant Stripe
 *  invoice PDF is attached by the sender (lib/email/billing-email.ts). */
export function ReceiptEmail({
	orgName,
	planLabel,
	amountLabel,
	periodLabel,
	cardLabel,
	invoiceNumber,
	billingUrl = "https://alethialabs.io/settings/billing",
}: ReceiptEmailProps) {
	return (
		<EmailLayout
			preview={`Receipt for ${amountLabel} — thank you.`}
			legal={<BillingLegal />}
		>
			<Text className="a-text-3" style={text.eyebrow}>
				Receipt
			</Text>
			<Heading as="h2" className="a-text" style={text.heading}>
				Payment received.
			</Heading>
			<Text className="a-text-2" style={text.body}>
				Thanks — we&apos;ve received your payment for{" "}
				<strong>{orgName}</strong>. Your Alethia {planLabel} plan is active. A
				PDF copy of this invoice is attached for your records.
			</Text>

			<SummaryTable
				rows={[
					{ label: "Plan", value: `Alethia ${planLabel}` },
					...(periodLabel ? [{ label: "Billing period", value: periodLabel }] : []),
					...(cardLabel ? [{ label: "Payment method", value: cardLabel }] : []),
					...(invoiceNumber
						? [{ label: "Invoice", value: invoiceNumber }]
						: []),
					{ label: "Total", value: amountLabel, strong: true },
				]}
			/>

			<Callout label="Manage billing">
				Change your plan, update your payment method, or download past invoices any
				time from billing settings.
			</Callout>

			<Button href={billingUrl} className="a-btn" style={primaryButton}>
				View billing →
			</Button>
		</EmailLayout>
	);
}

ReceiptEmail.PreviewProps = {
	orgName: "Acme Cloud",
	planLabel: "Pro",
	amountLabel: "$58.00",
	periodLabel: "Jul 3 – Aug 3, 2026",
	cardLabel: "Visa •••• 4242",
	invoiceNumber: "ABCD-0001",
	billingUrl: "https://alethialabs.io/settings/billing",
} satisfies ReceiptEmailProps;

export default ReceiptEmail;

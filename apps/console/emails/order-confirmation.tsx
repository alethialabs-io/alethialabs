// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Heading, Text } from "@react-email/components";
import { EmailLayout } from "@repo/email/components/layout";
import { text } from "@repo/email/components/theme";
import { BillingLegal, Callout, SummaryTable } from "./billing-shared";

export interface OrderConfirmationEmailProps {
	orgName: string;
	/** What was bought, as the product names it. */
	productLabel: string;
	/** Total charged, tax-inclusive, already formatted, e.g. "€120.00". */
	totalLabel: string;
	/** Which regime applies. Consumer orders carry the statutory rights below. */
	capacity: "consumer" | "organization";
	/** Whether it renews, and the notice to stop it. */
	renewsAutomatically: boolean;
	renewalLabel?: string;
	/** Terms version in force at the order, e.g. "2026-08-24". */
	termsVersion: string;
	/** Last day of the statutory withdrawal period — consumer orders only. */
	withdrawalEndsLabel?: string;
	/** Whether the consumer asked for the service to start inside that period. */
	immediatePerformance?: boolean;
	consumerRightsUrl?: string;
	billingUrl?: string;
}

export const subject = "Your Alethia order";

/**
 * The DURABLE CONFIRMATION a consumer must receive on a distance contract (CRD art. 8(7)).
 *
 * "Durable" is what makes this an email rather than a toast: the consumer must be able to keep it,
 * unchanged, and read it back later. That also decides what it contains — the confirmation is where
 * the pre-contractual information becomes something they hold, so the total, the renewal terms, the
 * document version and the withdrawal position all have to be IN it rather than linked from it.
 *
 * The withdrawal block renders for a consumer only. An organization purchase carries no statutory
 * withdrawal right, and telling a business it has one would be a promise we then could not keep
 * consistently.
 */
export function OrderConfirmationEmail({
	orgName,
	productLabel,
	totalLabel,
	capacity,
	renewsAutomatically,
	renewalLabel,
	termsVersion,
	withdrawalEndsLabel,
	immediatePerformance = false,
	consumerRightsUrl = "https://alethialabs.io/consumer-rights",
	billingUrl = "https://alethialabs.io/dashboard/settings/billing",
}: OrderConfirmationEmailProps) {
	const isConsumer = capacity === "consumer";
	return (
		<EmailLayout
			preview={`Your Alethia ${productLabel} order — ${totalLabel}.`}
			legal={<BillingLegal />}
		>
			<Text className="a-text-3" style={text.eyebrow}>
				Order confirmed
			</Text>
			<Heading as="h2" className="a-text" style={text.heading}>
				Keep this confirmation.
			</Heading>
			<Text className="a-text-2" style={text.body}>
				This confirms your order for <strong>{orgName}</strong>. It records what
				you bought, what you paid, and the rights that apply — keep it.
			</Text>

			<SummaryTable
				rows={[
					{ label: "Product", value: `Alethia ${productLabel}` },
					{ label: "Total paid (incl. tax)", value: totalLabel, strong: true },
					{
						label: "Renews",
						value: renewsAutomatically
							? (renewalLabel ?? "Automatically, until cancelled")
							: "No — this does not renew",
					},
					{ label: "Terms version", value: termsVersion },
					{
						label: "Buying as",
						value: isConsumer ? "An individual (consumer)" : "An organization",
					},
				]}
			/>

			{isConsumer && withdrawalEndsLabel ? (
				<Callout label="Your 14-day right to withdraw">
					You can withdraw from this contract until{" "}
					<strong>{withdrawalEndsLabel}</strong>, without giving a reason.{" "}
					{immediatePerformance
						? "Because you asked us to start straight away and confirmed you understood the " +
							"consequence, you would pay only for the part supplied before you withdraw — we show " +
							"you the exact amount before you confirm."
						: "Because you asked us to wait until the period ends, withdrawing costs you nothing."}{" "}
					Withdraw from billing settings, or read the full details at {consumerRightsUrl}.
				</Callout>
			) : null}

			<Callout label="Cancelling later">
				Cancelling stops the next renewal and your access continues to the end of
				the period you have already paid for. There is no refund for the unused
				part. Manage it at {billingUrl}.
			</Callout>
		</EmailLayout>
	);
}

OrderConfirmationEmail.PreviewProps = {
	orgName: "Acme Cloud",
	productLabel: "Pro",
	totalLabel: "€120.00",
	capacity: "consumer",
	renewsAutomatically: true,
	renewalLabel: "Monthly, until cancelled",
	termsVersion: "2026-08-24",
	withdrawalEndsLabel: "Sep 7, 2026",
	immediatePerformance: true,
} satisfies OrderConfirmationEmailProps;

export default OrderConfirmationEmail;

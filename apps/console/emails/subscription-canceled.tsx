// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button, Heading, Text } from "@react-email/components";
import { EmailLayout } from "@repo/email/components/layout";
import { primaryButton, text } from "@repo/email/components/theme";
import { BillingLegal, Callout, SummaryTable } from "./billing-shared";

export interface SubscriptionCanceledEmailProps {
	/** Organization whose subscription was canceled. */
	orgName: string;
	/** Plan that was canceled, e.g. "Pro". */
	planLabel: string;
	/** Date paid access ends / ended, e.g. "Aug 3, 2026". */
	accessUntilLabel?: string;
	/** Absolute link to resubscribe. */
	billingUrl?: string;
}

export const subject = "Your Alethia subscription was canceled";

/** Sent on customer.subscription.deleted — confirms cancellation and the date paid
 *  access ends, with a path back. */
export function SubscriptionCanceledEmail({
	orgName,
	planLabel,
	accessUntilLabel,
	billingUrl = "https://alethialabs.io/settings/billing",
}: SubscriptionCanceledEmailProps) {
	return (
		<EmailLayout
			preview={`Your Alethia ${planLabel} subscription has been canceled.`}
			legal={<BillingLegal />}
		>
			<Text className="a-text-3" style={text.eyebrow}>
				Canceled
			</Text>
			<Heading as="h2" className="a-text" style={text.heading}>
				Your subscription was canceled.
			</Heading>
			<Text className="a-text-2" style={text.body}>
				The Alethia {planLabel} subscription for <strong>{orgName}</strong> has
				been canceled
				{accessUntilLabel ? (
					<>
						{" "}
						— you keep {planLabel} access until <strong>{accessUntilLabel}</strong>,
						after which the organization moves to the free Community tier
					</>
				) : null}
				. You can resubscribe any time; your projects and configuration stay
				intact.
			</Text>

			{accessUntilLabel ? (
				<SummaryTable
					rows={[
						{ label: "Plan", value: `Alethia ${planLabel}` },
						{ label: "Access until", value: accessUntilLabel, strong: true },
					]}
				/>
			) : null}

			<Callout label="Your data">
				Nothing is deleted. Your projects and configuration remain exactly as they
				are — resubscribe any time to restore {planLabel} features.
			</Callout>

			<Button href={billingUrl} className="a-btn" style={primaryButton}>
				Resubscribe →
			</Button>
		</EmailLayout>
	);
}

SubscriptionCanceledEmail.PreviewProps = {
	orgName: "Acme Cloud",
	planLabel: "Pro",
	accessUntilLabel: "Aug 3, 2026",
	billingUrl: "https://alethialabs.io/settings/billing",
} satisfies SubscriptionCanceledEmailProps;

export default SubscriptionCanceledEmail;

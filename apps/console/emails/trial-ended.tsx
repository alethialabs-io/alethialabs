// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button, Heading, Text } from "@react-email/components";
import { EmailLayout } from "@repo/email/components/layout";
import { primaryButton, text } from "@repo/email/components/theme";
import { BillingLegal, Callout, SummaryTable } from "./billing-shared";

export interface TrialEndedEmailProps {
	/** Organization whose trial ended. */
	orgName: string;
	/** Plan that was trialed, e.g. "Pro". */
	planLabel: string;
	/** When the trial ended, e.g. "Jul 6, 2026". */
	trialEndLabel?: string;
	/** Why it ended: a card-less Stripe trial with no payment method added (the default), or a local
	 *  trial (lib/billing/trial/local.ts) that ran out with no subscription started. */
	reason?: "no_payment_method" | "not_subscribed";
	/** Absolute link to subscribe. */
	billingUrl?: string;
}

export const subject = "Your Alethia trial has ended";

/** Sent on customer.subscription.deleted when a card-less trial ran out with no payment method
 *  (lib/billing/trial/end.ts), and by the trial-notice sweep (lib/billing/trial/notices.ts) when a
 *  local trial ran out with no subscription — says the organization is on Hobby now, that nothing
 *  was deleted, and how to subscribe. Never sent for a customer's own cancellation, which gets the
 *  subscription-canceled email instead. */
export function TrialEndedEmail({
	orgName,
	planLabel,
	trialEndLabel,
	reason = "no_payment_method",
	billingUrl = "https://alethialabs.io/dashboard/settings/billing",
}: TrialEndedEmailProps) {
	return (
		<EmailLayout
			preview={`Your Alethia ${planLabel} trial has ended. ${orgName} is on Hobby now.`}
			legal={<BillingLegal />}
		>
			<Text className="a-text-3" style={text.eyebrow}>
				Trial ended
			</Text>
			<Heading as="h2" className="a-text" style={text.heading}>
				Your trial has ended.
			</Heading>
			<Text className="a-text-2" style={text.body}>
				The Alethia {planLabel} trial for <strong>{orgName}</strong> has ended, and{" "}
				{reason === "not_subscribed" ? "no subscription was started" : "no payment method was added"}.
				The organization is now on the free Hobby plan, and Hobby&apos;s limits apply from today. You were not charged.
			</Text>

			<SummaryTable
				rows={[
					{ label: "Plan now", value: "Alethia Hobby", strong: true },
					...(trialEndLabel ? [{ label: "Trial ended", value: trialEndLabel }] : []),
				]}
			/>

			<Callout label="Your data">
				Nothing is deleted. Your projects, members and configuration stay as they are.
				Subscribe to {planLabel} at any time to lift the Hobby limits.
			</Callout>

			<Button href={billingUrl} className="a-btn" style={primaryButton}>
				Subscribe to {planLabel} →
			</Button>
		</EmailLayout>
	);
}

TrialEndedEmail.PreviewProps = {
	orgName: "Acme Cloud",
	planLabel: "Pro",
	trialEndLabel: "Jul 6, 2026",
	billingUrl: "https://alethialabs.io/dashboard/settings/billing",
} satisfies TrialEndedEmailProps;

export default TrialEndedEmail;

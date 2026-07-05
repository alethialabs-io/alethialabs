// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button, Heading, Text } from "@react-email/components";
import { EmailLayout } from "@repo/email/components/layout";
import { primaryButton, text } from "@repo/email/components/theme";
import { BillingLegal, Callout, SummaryTable } from "./billing-shared";

export interface TrialEndingEmailProps {
	/** Organization on trial. */
	orgName: string;
	/** Plan being trialed, e.g. "Pro". */
	planLabel: string;
	/** When the trial ends, e.g. "Jul 6, 2026". */
	trialEndLabel: string;
	/** Absolute link to add a payment method. */
	billingUrl?: string;
}

export const subject = "Your Alethia trial ends soon";

/** Sent on customer.subscription.trial_will_end (~3 days out) — nudge to add a card
 *  so the plan doesn't lapse to community when the trial ends. */
export function TrialEndingEmail({
	orgName,
	planLabel,
	trialEndLabel,
	billingUrl = "https://alethialabs.io/settings/billing",
}: TrialEndingEmailProps) {
	return (
		<EmailLayout
			preview={`Your Alethia ${planLabel} trial ends ${trialEndLabel}.`}
			legal={<BillingLegal />}
		>
			<Text className="a-text-3" style={text.eyebrow}>
				Trial ending
			</Text>
			<Heading as="h2" className="a-text" style={text.heading}>
				Your trial ends soon.
			</Heading>
			<Text className="a-text-2" style={text.body}>
				Your Alethia {planLabel} trial for <strong>{orgName}</strong> ends on{" "}
				<strong>{trialEndLabel}</strong>. Add a payment method to keep your
				plan and everything you&apos;ve set up — otherwise the organization
				reverts to the free Community tier.
			</Text>

			<SummaryTable
				rows={[
					{ label: "Plan", value: `Alethia ${planLabel}` },
					{ label: "Trial ends", value: trialEndLabel, strong: true },
				]}
			/>

			<Callout label="If you don't add a card">
				Your organization moves to the free Community tier when the trial ends.
				Nothing is deleted — your projects and configuration stay, and you can add a
				card to upgrade any time.
			</Callout>

			<Button href={billingUrl} className="a-btn" style={primaryButton}>
				Add payment method →
			</Button>
		</EmailLayout>
	);
}

TrialEndingEmail.PreviewProps = {
	orgName: "Acme Cloud",
	planLabel: "Pro",
	trialEndLabel: "Jul 6, 2026",
	billingUrl: "https://alethialabs.io/settings/billing",
} satisfies TrialEndingEmailProps;

export default TrialEndingEmail;

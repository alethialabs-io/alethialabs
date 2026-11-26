// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
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
	/** Whether a payment method is already on file — then the plan continues and nothing is asked. */
	paymentMethodOnFile?: boolean;
	/** Whether keeping the plan means SUBSCRIBING rather than adding a card to an existing
	 *  subscription — a local trial (lib/billing/trial/local.ts) has no subscription to add one to. */
	subscribeToKeep?: boolean;
	/** Absolute link to add a payment method (or subscribe). */
	billingUrl?: string;
}

export const subject = "Your Alethia trial ends soon";

/** Sent ~3 days before a trial ends: on customer.subscription.trial_will_end for a Stripe trial, and
 *  by the trial-notice sweep (lib/billing/trial/notices.ts) for a local trial. Without a payment
 *  method on file it asks for one (or, for a local trial, a subscription), because the trial then
 *  ends and the organization returns to Hobby with its data kept; with one on file it says the plan
 *  continues. */
export function TrialEndingEmail({
	orgName,
	planLabel,
	trialEndLabel,
	paymentMethodOnFile = false,
	subscribeToKeep = false,
	billingUrl = "https://alethialabs.io/dashboard/settings/billing",
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
			{paymentMethodOnFile ? (
				<Text className="a-text-2" style={text.body}>
					Your Alethia {planLabel} trial for <strong>{orgName}</strong> ends on{" "}
					<strong>{trialEndLabel}</strong>. A payment method is on file, so{" "}
					{planLabel} continues and the first invoice is charged to it then. You can
					change or cancel the plan from billing before that date.
				</Text>
			) : (
				<Text className="a-text-2" style={text.body}>
					Your Alethia {planLabel} trial for <strong>{orgName}</strong> ends on{" "}
					<strong>{trialEndLabel}</strong>.{" "}
					{subscribeToKeep ? `Subscribe to keep ${planLabel}.` : `Add a payment method to keep ${planLabel}.`}{" "}
					Otherwise the organization moves to the free Hobby plan when the trial ends.
				</Text>
			)}

			<SummaryTable
				rows={[
					{ label: "Plan", value: `Alethia ${planLabel}` },
					{ label: "Trial ends", value: trialEndLabel, strong: true },
				]}
			/>

			{paymentMethodOnFile ? null : (
				<Callout label={subscribeToKeep ? "If you don't subscribe" : "If you don't add a payment method"}>
					Your organization moves to the free Hobby plan when the trial ends, and the
					Hobby limits apply. Nothing is deleted: your projects, members and
					configuration stay, and you can subscribe at any time.
				</Callout>
			)}

			<Button href={billingUrl} className="a-btn" style={primaryButton}>
				{paymentMethodOnFile
					? "Manage billing →"
					: subscribeToKeep
						? `Subscribe to ${planLabel} →`
						: "Add payment method →"}
			</Button>
		</EmailLayout>
	);
}

TrialEndingEmail.PreviewProps = {
	orgName: "Acme Cloud",
	planLabel: "Pro",
	trialEndLabel: "Jul 6, 2026",
	paymentMethodOnFile: false,
	billingUrl: "https://alethialabs.io/dashboard/settings/billing",
} satisfies TrialEndingEmailProps;

export default TrialEndingEmail;

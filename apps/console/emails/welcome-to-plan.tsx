// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button, Heading, Text } from "@react-email/components";
import { EmailLayout } from "@repo/email/components/layout";
import { primaryButton, text } from "@repo/email/components/theme";
import { BillingLegal, FeatureRows, type FeatureRow } from "./billing-shared";

export interface WelcomeToPlanEmailProps {
	/** Organization now on the plan. */
	orgName: string;
	/** Plan display name, e.g. "Pro". */
	planName: string;
	/** Plan tagline, e.g. "Collaborate in a shared organization." */
	tagline: string;
	/** Whether this activation is a trial (softens the copy) vs a paid start. */
	isTrial?: boolean;
	/** "What's included" rows (from planMeta checkoutFeatures/highlights). */
	features: FeatureRow[];
	/** Absolute link to the console. */
	consoleUrl?: string;
}

/** Subject for the plan-welcome email. */
export function subject(
	props: Pick<WelcomeToPlanEmailProps, "planName" | "isTrial">,
): string {
	return props.isTrial
		? `Your Alethia ${props.planName} trial is live`
		: `Welcome to Alethia ${props.planName}`;
}

/** Sent once, the first time an org reaches a paid plan (trial or paid). Rich
 *  onboarding into the plan — tagline + what's included + a CTA — matching the
 *  sophistication of the sign-up welcome email. */
export function WelcomeToPlanEmail({
	orgName,
	planName,
	tagline,
	isTrial,
	features = [],
	consoleUrl = "https://alethialabs.io",
}: WelcomeToPlanEmailProps) {
	return (
		<EmailLayout
			preview={
				isTrial
					? `Your Alethia ${planName} trial is live — ${tagline}`
					: `Welcome to Alethia ${planName} — ${tagline}`
			}
			legal={<BillingLegal />}
		>
			<Text className="a-text-3" style={text.eyebrow}>
				{isTrial ? `${planName} · Trial` : `Welcome to ${planName}`}
			</Text>
			<Heading as="h2" className="a-text" style={text.heading}>
				{isTrial
					? `Your ${planName} trial is live.`
					: `You're on Alethia ${planName}.`}
			</Heading>
			<Text className="a-text-2" style={text.body}>
				{tagline} <strong>{orgName}</strong>{" "}
				{isTrial
					? "now has everything in the plan for the length of your trial:"
					: "now has everything in the plan:"}
			</Text>

			<FeatureRows rows={features} />

			<Text
				className="a-text-2"
				style={{ ...text.body, marginBottom: "22px" }}
			>
				{isTrial
					? "Add a payment method before the trial ends to keep it — we'll remind you a few days out."
					: "Manage seats, invoices, and your payment method any time from billing settings."}
			</Text>

			<Button href={consoleUrl} className="a-btn" style={primaryButton}>
				Open the console →
			</Button>
		</EmailLayout>
	);
}

WelcomeToPlanEmail.PreviewProps = {
	orgName: "Acme Cloud",
	planName: "Pro",
	tagline: "Collaborate in a shared organization.",
	isTrial: false,
	features: [
		{ title: "Flexible usage credit", detail: "$20/mo toward metered runner-minutes & AI" },
		{ title: "Organizations & teams", detail: "Invite teammates with role-based access" },
		{ title: "Shared Projects", detail: "Collaborate on infrastructure across the team" },
		{ title: "Included runner-minutes", detail: "500 managed build-minutes / month" },
		{ title: "Standard AI", detail: "3,000 AI credits / week for repo scans & chat" },
	],
	consoleUrl: "https://alethialabs.io",
} satisfies WelcomeToPlanEmailProps;

export default WelcomeToPlanEmail;

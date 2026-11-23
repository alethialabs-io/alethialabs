// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button, Heading, Text } from "@react-email/components";
import { EmailLayout } from "@repo/email/components/layout";
import { primaryButton, text } from "@repo/email/components/theme";
import { BillingLegal } from "./billing-shared";

export interface EarlyAccessGrantedEmailProps {
	/** The organization the access was granted to. */
	orgName: string;
	/** The plan granted, as a display name ("Team", "AI Plus"). */
	planName: string;
	/** The last day of the grant, already formatted, or null for a grant with no end date. */
	endsOn: string | null;
	/** Absolute link to the console. */
	consoleUrl?: string;
}

/**
 * The sentences this email is held to (decisions-2026-11-23-early-access.md §2). They are exported
 * so a test can pin them: the access is free, nothing is owed for it, and no part of it is ever
 * charged. The email names no price and promises no future price, and it does not describe a
 * subscription that will start: billing, if it ever happens, is a separate choice made later and
 * charged only from then on.
 */
export const GRANT_TERMS = {
	complimentary: "This access is complimentary.",
	nothingOwed: "Nothing is owed for it, now or later.",
	neverCharged: "No part of this complimentary period will ever be charged.",
	choiceLater:
		"If you decide to subscribe once paid plans open in your country, that is a separate choice you make then, and it is charged only from that day forward.",
} as const;

/** Subject for the grant email. */
export function subject(props: Pick<EarlyAccessGrantedEmailProps, "planName">): string {
	return `Complimentary Early Access to Alethia ${props.planName}`;
}

/**
 * Sent to the organization's owner when staff grant a complimentary Early Access request (EA-3,
 * #7325). It replaces the plan-welcome email for this grant, which talks about invoices and payment
 * methods that do not exist here.
 */
export function EarlyAccessGrantedEmail({
	orgName,
	planName,
	endsOn,
	consoleUrl = "https://alethialabs.io",
}: EarlyAccessGrantedEmailProps) {
	return (
		<EmailLayout
			preview={`${orgName} has complimentary Early Access to Alethia ${planName}`}
			legal={<BillingLegal />}
		>
			<Text className="a-text-3" style={text.eyebrow}>
				Early Access · Complimentary
			</Text>
			<Heading as="h2" className="a-text" style={text.heading}>
				{orgName} has Alethia {planName}.
			</Heading>
			<Text className="a-text-2" style={text.body}>
				Your request was granted. <strong>{orgName}</strong> now has everything in {planName}
				{endsOn ? `, until ${endsOn}` : ""}.
			</Text>
			<Text className="a-text-2" style={text.body}>
				{GRANT_TERMS.complimentary} {GRANT_TERMS.nothingOwed} {GRANT_TERMS.neverCharged}
			</Text>
			<Text className="a-text-2" style={{ ...text.body, marginBottom: "22px" }}>
				{GRANT_TERMS.choiceLater}
				{endsOn
					? " When the grant ends, the organization returns to the free plan; nothing is charged."
					: ""}
			</Text>
			<Button href={consoleUrl} className="a-btn" style={primaryButton}>
				Open the console →
			</Button>
		</EmailLayout>
	);
}

EarlyAccessGrantedEmail.PreviewProps = {
	orgName: "Acme GmbH",
	planName: "Team",
	endsOn: "23 Feb 2027",
	consoleUrl: "https://alethialabs.io",
} satisfies EarlyAccessGrantedEmailProps;

export default EarlyAccessGrantedEmail;

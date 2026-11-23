// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Heading, Text } from "@react-email/components";
import { EmailLayout } from "@repo/email/components/layout";
import { colors, fonts, text } from "@repo/email/components/theme";

/** The VIES verdict as the alert states it. */
export type EarlyAccessViesLine = "valid" | "invalid" | "unchecked";

export interface EarlyAccessRequestEmailProps {
	/** The request's id, so staff can find it on the admin Early Access page. */
	requestId: string;
	orgName: string;
	orgSlug: string | null;
	/** ISO 3166-1 alpha-2 country of the VAT number. */
	country: string;
	/** The VAT number as stored (prefix plus number). */
	vatId: string;
	/** The plan asked for, as a display name. */
	planName: string;
	/** What VIES said; `unchecked` when it could not be asked. */
	vies: EarlyAccessViesLine;
	/** The registered name VIES returned, when it returned one. */
	viesName: string | null;
	/** The billing admin who filed it. */
	requesterEmail: string | null;
	/** The requester's optional note. */
	note: string | null;
}

/** The sentence every alert carries, verbatim, because it is the filing reminder (decisions §2). */
export const ART_97A_REMINDER = "Art. 97a must be filed when this client commits to pay.";

/** The subject line, e.g. "Early Access request: Acme GmbH (DE, DE123456789)". */
export function subject(props: Pick<EarlyAccessRequestEmailProps, "orgName" | "country" | "vatId">): string {
	return `Early Access request: ${props.orgName} (${props.country}, ${props.vatId})`;
}

/** What the VIES line says for each verdict. */
function viesSentence(vies: EarlyAccessViesLine, name: string | null): string {
	if (vies === "valid") return `VIES: valid${name ? ` — ${name}` : ""}.`;
	if (vies === "invalid") return "VIES: NOT valid. Check the number with the requester before granting.";
	return "VIES: not checked (the service did not answer). Check the number before granting.";
}

/**
 * Internal email to the legal inbox for a complimentary Early Access request (EA-3, #7325). It names
 * the organization, the country and the VAT number, says what VIES returned, and carries the Art. 97a
 * reminder. Nothing has been granted when it is sent: a person decides on the admin page.
 */
export function EarlyAccessRequestEmail(props: EarlyAccessRequestEmailProps) {
	const line = { ...text.body, margin: "0 0 12px" };
	const mono = {
		...text.body,
		margin: 0,
		fontFamily: fonts.mono,
		fontSize: "12.5px",
		color: colors.textTertiary,
	};
	return (
		<EmailLayout
			preview={`Early Access request from ${props.orgName} (${props.country})`}
			legal="Internal: an organization asked for a complimentary Early Access grant from the Alethia console."
		>
			<Text style={text.eyebrow}>Early Access · Complimentary grant request</Text>
			<Heading style={text.heading}>{props.orgName}</Heading>
			<Text style={line}>
				The billing admin of {props.orgName} asked for complimentary access to {props.planName}. The
				organization is in {props.country} and gave the VAT number {props.vatId}.
			</Text>
			<Text style={line}>{viesSentence(props.vies, props.viesName)}</Text>
			<Text style={{ ...line, fontWeight: 600 }}>{ART_97A_REMINDER}</Text>
			<Text style={line}>
				Nothing has been granted. Decide on the admin app&apos;s Early Access page.
			</Text>
			{props.note ? <Text style={line}>Their note: “{props.note}”</Text> : null}
			<Text style={mono}>request id: {props.requestId}</Text>
			{props.orgSlug ? <Text style={mono}>org: /{props.orgSlug}</Text> : null}
			{props.requesterEmail ? <Text style={mono}>requested by: {props.requesterEmail}</Text> : null}
		</EmailLayout>
	);
}

EarlyAccessRequestEmail.PreviewProps = {
	requestId: "00000000-0000-4000-8000-000000000000",
	orgName: "Acme GmbH",
	orgSlug: "acme",
	country: "DE",
	vatId: "DE123456789",
	planName: "Team",
	vies: "valid",
	viesName: "ACME GMBH",
	requesterEmail: "billing@acme.example",
	note: null,
} satisfies EarlyAccessRequestEmailProps;

export default EarlyAccessRequestEmail;

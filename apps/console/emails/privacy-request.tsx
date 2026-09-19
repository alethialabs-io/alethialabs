// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Heading, Text } from "@react-email/components";
import { EmailLayout } from "@repo/email/components/layout";
import { colors, fonts, text } from "@repo/email/components/theme";

interface PrivacyRequestEmailProps {
	/** The case's DSR- reference, quoted in all correspondence about it. */
	reference: string;
	/** The subject's user id, so the case can be found without the address. */
	subjectUserId: string;
	/** The subject's account address, so the privacy team can reply to them. */
	subjectEmail: string;
	/** When the request was received, as an ISO-8601 instant. */
	receivedAt: string;
	/** When the response is due, as an ISO-8601 instant. */
	dueAt: string;
}

/** The subject line, e.g. "Erasure request DSR-1A2B3C4D — due 2026-10-19". */
export function subject(reference: string, dueAt: string): string {
	return `Erasure request ${reference} — due ${dueAt.slice(0, 10)}`;
}

/**
 * Internal email to the privacy inbox for an erasure request a user opened about themselves from
 * the console's account settings. It is how a person finds out the case exists: the case row alone
 * reaches nobody. It says what is settled (identity, by the signed-in session), what is not (nothing
 * has been erased), and when the response is due.
 */
export function PrivacyRequestEmail({
	reference,
	subjectUserId,
	subjectEmail,
	receivedAt,
	dueAt,
}: PrivacyRequestEmailProps) {
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
			preview={`Erasure request ${reference} from ${subjectEmail}`}
			legal="Internal: a user asked for their account to be erased from the Alethia console."
		>
			<Text style={text.eyebrow}>Privacy request · Erasure</Text>
			<Heading style={text.heading}>{reference}</Heading>
			<Text style={line}>
				{subjectEmail} asked for their account and the personal data tied to it to be erased.
				They made the request while signed in to the console, and that session is recorded on
				the case as the identity check.
			</Text>
			<Text style={line}>
				Nothing has been erased. The request is waiting for a person to handle it under the
				privacy request runbook.
			</Text>
			<Text style={mono}>user id: {subjectUserId}</Text>
			<Text style={mono}>received: {receivedAt}</Text>
			<Text style={mono}>response due: {dueAt}</Text>
		</EmailLayout>
	);
}

export default PrivacyRequestEmail;

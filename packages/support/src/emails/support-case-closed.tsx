// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button, Heading, Text } from "@react-email/components";
import { EmailLayout } from "@repo/email/components/layout";
import { colors, primaryButton, text } from "@repo/email/components/theme";

/** Renders a case number as its `CASE-000123` display form. */
function caseLabel(caseNumber: number): string {
	return `CASE-${String(caseNumber).padStart(6, "0")}`;
}

/** Subject for the case-closed notification. */
export function subject(caseNumber: number): string {
	return `[${caseLabel(caseNumber)}] Your support case was closed`;
}

interface SupportCaseClosedEmailProps {
	caseNumber?: number;
	url?: string;
}

/**
 * Notification that a support case was closed. A closed case is done, but the customer
 * can reopen it from the thread if the issue resurfaces.
 */
export function SupportCaseClosedEmail({
	caseNumber = 1234,
	url = "https://alethialabs.io/support",
}: SupportCaseClosedEmailProps) {
	return (
		<EmailLayout
			preview={`${caseLabel(caseNumber)} was closed`}
			legal="You're receiving this because you had a support case on Alethia."
		>
			<Text className="a-text-3" style={text.eyebrow}>
				Support · {caseLabel(caseNumber)}
			</Text>
			<Heading as="h2" className="a-text" style={text.heading}>
				Your case has been closed.
			</Heading>
			<Text className="a-text-2" style={text.body}>
				We&apos;ve closed{" "}
				<strong
					className="a-text"
					style={{ color: colors.textPrimary, fontWeight: 500 }}
				>
					{caseLabel(caseNumber)}
				</strong>
				. If the issue comes back, reply from the thread to reopen it — we keep the
				full history.
			</Text>

			<Button href={url} className="a-btn" style={primaryButton}>
				View your case →
			</Button>
		</EmailLayout>
	);
}

SupportCaseClosedEmail.PreviewProps = {
	caseNumber: 1234,
	url: "https://alethialabs.io/support",
} satisfies SupportCaseClosedEmailProps;

export default SupportCaseClosedEmail;

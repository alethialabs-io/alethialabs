// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button, Heading, Text } from "@react-email/components";
import { EmailLayout } from "@repo/email/components/layout";
import { colors, primaryButton, text } from "@repo/email/components/theme";

/** Renders a case number as its `CASE-000123` display form. */
function caseLabel(caseNumber: number): string {
	return `CASE-${String(caseNumber).padStart(6, "0")}`;
}

/** Subject for the case-reopened notification. */
export function subject(caseNumber: number): string {
	return `[${caseLabel(caseNumber)}] Your support case was reopened`;
}

interface SupportCaseReopenedEmailProps {
	caseNumber?: number;
	url?: string;
}

/**
 * Notification that a resolved/closed support case was reopened — activity resumes and
 * a response is expected. Links back to the thread.
 */
export function SupportCaseReopenedEmail({
	caseNumber = 1234,
	url = "https://alethialabs.io/support",
}: SupportCaseReopenedEmailProps) {
	return (
		<EmailLayout
			preview={`${caseLabel(caseNumber)} was reopened`}
			legal="You're receiving this because you have a support case on Alethia."
		>
			<Text className="a-text-3" style={text.eyebrow}>
				Support · {caseLabel(caseNumber)}
			</Text>
			<Heading as="h2" className="a-text" style={text.heading}>
				Your case has been reopened.
			</Heading>
			<Text className="a-text-2" style={text.body}>
				<strong
					className="a-text"
					style={{ color: colors.textPrimary, fontWeight: 500 }}
				>
					{caseLabel(caseNumber)}
				</strong>{" "}
				is active again. We&apos;ll follow up in the thread — you can add more
				detail there any time.
			</Text>

			<Button href={url} className="a-btn" style={primaryButton}>
				View your case →
			</Button>
		</EmailLayout>
	);
}

SupportCaseReopenedEmail.PreviewProps = {
	caseNumber: 1234,
	url: "https://alethialabs.io/support",
} satisfies SupportCaseReopenedEmailProps;

export default SupportCaseReopenedEmail;

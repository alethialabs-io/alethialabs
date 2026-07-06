// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button, Heading, Text } from "@react-email/components";
import { EmailLayout } from "@repo/email/components/layout";
import { colors, primaryButton, text } from "@repo/email/components/theme";

/** Renders a case number as its `CASE-000123` display form. */
function caseLabel(caseNumber: number): string {
	return `CASE-${String(caseNumber).padStart(6, "0")}`;
}

/** Subject for the "we received your case" acknowledgement. */
export function subject(caseNumber: number, caseSubject: string): string {
	return `[${caseLabel(caseNumber)}] We received your request: ${caseSubject}`;
}

interface SupportCaseCreatedEmailProps {
	caseNumber?: number;
	caseSubject?: string;
	url?: string;
}

/**
 * Customer acknowledgement that a support case was opened. Confirms the case number,
 * echoes the subject, and links back to the case thread in the console.
 */
export function SupportCaseCreatedEmail({
	caseNumber = 1234,
	caseSubject = "Cluster provisioning failed in eu-central-1",
	url = "https://alethialabs.io/support",
}: SupportCaseCreatedEmailProps) {
	return (
		<EmailLayout
			preview={`We received ${caseLabel(caseNumber)} — ${caseSubject}`}
			legal="You're receiving this because you opened a support case on Alethia."
		>
			<Text className="a-text-3" style={text.eyebrow}>
				Support · {caseLabel(caseNumber)}
			</Text>
			<Heading as="h2" className="a-text" style={text.heading}>
				We&apos;ve received your request.
			</Heading>
			<Text className="a-text-2" style={text.body}>
				Thanks for reaching out. Your case{" "}
				<strong
					className="a-text"
					style={{ color: colors.textPrimary, fontWeight: 500 }}
				>
					{caseLabel(caseNumber)}
				</strong>{" "}
				is open and our team will follow up shortly.
			</Text>
			<Text
				className="a-text-2"
				style={{ ...text.body, color: colors.textPrimary }}
			>
				{caseSubject}
			</Text>

			<Button href={url} className="a-btn" style={primaryButton}>
				View your case →
			</Button>
		</EmailLayout>
	);
}

SupportCaseCreatedEmail.PreviewProps = {
	caseNumber: 1234,
	caseSubject: "Cluster provisioning failed in eu-central-1",
	url: "https://alethialabs.io/support",
} satisfies SupportCaseCreatedEmailProps;

export default SupportCaseCreatedEmail;

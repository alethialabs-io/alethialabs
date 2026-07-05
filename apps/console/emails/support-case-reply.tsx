// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button, Heading, Section, Text } from "@react-email/components";
import { EmailLayout } from "@repo/email/components/layout";
import { colors, radii, primaryButton, text } from "@repo/email/components/theme";

/** Renders a case number as its `CASE-000123` display form. */
function caseLabel(caseNumber: number): string {
	return `CASE-${String(caseNumber).padStart(6, "0")}`;
}

/** Subject for a new-reply notification. */
export function subject(caseNumber: number): string {
	return `[${caseLabel(caseNumber)}] New reply on your support case`;
}

interface SupportCaseReplyEmailProps {
	caseNumber?: number;
	author?: string;
	snippet?: string;
	url?: string;
}

/**
 * Notification that a new reply landed on a support case. Names the author, shows a
 * short snippet of the message, and links to the full thread.
 */
export function SupportCaseReplyEmail({
	caseNumber = 1234,
	author = "Alethia Support",
	snippet = "Thanks for the details — could you share the job id so we can pull the runner logs?",
	url = "https://alethialabs.io/support",
}: SupportCaseReplyEmailProps) {
	return (
		<EmailLayout
			preview={`New reply on ${caseLabel(caseNumber)} from ${author}`}
			legal="You're receiving this because you have an open support case on Alethia."
		>
			<Text className="a-text-3" style={text.eyebrow}>
				Support · {caseLabel(caseNumber)}
			</Text>
			<Heading as="h2" className="a-text" style={text.heading}>
				{author} replied to your case.
			</Heading>

			<Section
				className="a-sunken a-border"
				style={{
					backgroundColor: colors.surfaceSunken,
					border: `1px solid ${colors.border}`,
					borderRadius: radii.md,
					padding: "16px 18px",
					margin: "8px 0 24px",
				}}
			>
				<Text
					className="a-text-2"
					style={{ ...text.body, margin: 0, whiteSpace: "pre-wrap" }}
				>
					{snippet}
				</Text>
			</Section>

			<Button href={url} className="a-btn" style={primaryButton}>
				View the conversation →
			</Button>
		</EmailLayout>
	);
}

SupportCaseReplyEmail.PreviewProps = {
	caseNumber: 1234,
	author: "Alethia Support",
	snippet:
		"Thanks for the details — could you share the job id so we can pull the runner logs?",
	url: "https://alethialabs.io/support",
} satisfies SupportCaseReplyEmailProps;

export default SupportCaseReplyEmail;

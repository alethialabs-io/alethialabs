// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Button, Heading, Text } from "@react-email/components";
import { EmailLayout } from "@repo/email/components/layout";
import { colors, primaryButton, text } from "@repo/email/components/theme";

/** Renders a case number as its `CASE-000123` display form. */
function caseLabel(caseNumber: number): string {
	return `CASE-${String(caseNumber).padStart(6, "0")}`;
}

/** Subject for the case-assigned notification. */
export function subject(caseNumber: number): string {
	return `[${caseLabel(caseNumber)}] An agent is on your case`;
}

interface SupportCaseAssignedEmailProps {
	caseNumber?: number;
	agentName?: string;
	url?: string;
}

/**
 * Notification that a support agent picked up the customer's case — reassures them a
 * human is now on it. Names the agent when known.
 */
export function SupportCaseAssignedEmail({
	caseNumber = 1234,
	agentName = "An Alethia agent",
	url = "https://alethialabs.io/support",
}: SupportCaseAssignedEmailProps) {
	return (
		<EmailLayout
			preview={`${agentName} is now on ${caseLabel(caseNumber)}`}
			legal="You're receiving this because you have an open support case on Alethia."
		>
			<Text className="a-text-3" style={text.eyebrow}>
				Support · {caseLabel(caseNumber)}
			</Text>
			<Heading as="h2" className="a-text" style={text.heading}>
				An agent is on your case.
			</Heading>
			<Text className="a-text-2" style={text.body}>
				<strong
					className="a-text"
					style={{ color: colors.textPrimary, fontWeight: 500 }}
				>
					{agentName}
				</strong>{" "}
				has picked up{" "}
				<strong
					className="a-text"
					style={{ color: colors.textPrimary, fontWeight: 500 }}
				>
					{caseLabel(caseNumber)}
				</strong>{" "}
				and will follow up in the thread shortly.
			</Text>

			<Button href={url} className="a-btn" style={primaryButton}>
				View your case →
			</Button>
		</EmailLayout>
	);
}

SupportCaseAssignedEmail.PreviewProps = {
	caseNumber: 1234,
	agentName: "Jordan from Alethia",
	url: "https://alethialabs.io/support",
} satisfies SupportCaseAssignedEmailProps;

export default SupportCaseAssignedEmail;

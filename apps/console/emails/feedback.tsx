// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Heading, Section, Text } from "@react-email/components";
import { EmailLayout } from "@repo/email/components/layout";
import {
	colors,
	fonts,
	radii,
	text,
} from "@repo/email/components/theme";
import {
	type FeedbackTopic,
	FEEDBACK_TOPIC_LABELS,
} from "@/lib/validations/feedback";

interface FeedbackEmailProps {
	/** The feedback category the user picked. */
	topic: FeedbackTopic;
	/** Satisfaction rating, 1–5. */
	rating: number;
	/** The free-text feedback body. */
	message: string;
	/** The submitter's account email, so we can follow up. */
	fromEmail: string;
}

/** The email subject for a feedback submission, e.g. "Console feedback: Idea". */
export function subject(topic: FeedbackTopic): string {
	return `Console feedback: ${FEEDBACK_TOPIC_LABELS[topic]}`;
}

/** Renders a 1–5 rating as filled/empty stars plus the numeric value. */
function stars(rating: number): string {
	const clamped = Math.max(1, Math.min(5, rating));
	return `${"★".repeat(clamped)}${"☆".repeat(5 - clamped)} (${clamped}/5)`;
}

/**
 * Internal notification email for a console feedback submission (hosted-only). Sent
 * to the team feedback inbox; carries the topic, rating, message, and the submitter's
 * email for follow-up.
 */
export function FeedbackEmail({
	topic,
	rating,
	message,
	fromEmail,
}: FeedbackEmailProps) {
	return (
		<EmailLayout
			preview={`${FEEDBACK_TOPIC_LABELS[topic]} — ${stars(rating)}`}
			legal="Internal: a user submitted feedback from the Alethia console."
		>
			<Text style={text.eyebrow}>Feedback · {FEEDBACK_TOPIC_LABELS[topic]}</Text>
			<Heading style={text.heading}>{stars(rating)}</Heading>

			<Section
				style={{
					backgroundColor: colors.surfaceSunken,
					border: `1px solid ${colors.border}`,
					borderRadius: radii.md,
					padding: "16px 18px",
					margin: "8px 0 24px",
				}}
			>
				<Text style={{ ...text.body, margin: 0, whiteSpace: "pre-wrap" }}>
					{message}
				</Text>
			</Section>

			<Text
				style={{
					...text.body,
					margin: 0,
					fontFamily: fonts.mono,
					fontSize: "12.5px",
					color: colors.textTertiary,
				}}
			>
				from: {fromEmail}
			</Text>
		</EmailLayout>
	);
}

export default FeedbackEmail;

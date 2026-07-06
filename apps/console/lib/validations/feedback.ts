// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Validation for the in-app feedback widget (hosted-only). Feedback is emailed to
// Alethia Labs, never stored — so this is a plain zod input contract, shared by the
// feedback dialog (client) and the submitFeedback server action (re-validates).

import { z } from "zod";

/** The feedback categories offered in the dialog's topic select. */
export const FEEDBACK_TOPICS = ["bug", "idea", "question", "other"] as const;

/** Human labels for each topic, used by the dialog's select + the email subject. */
export const FEEDBACK_TOPIC_LABELS: Record<
	(typeof FEEDBACK_TOPICS)[number],
	string
> = {
	bug: "Bug",
	idea: "Idea",
	question: "Question",
	other: "Other",
};

/** A single feedback submission: a topic, a 1–5 satisfaction rating, and a message. */
export const feedbackSchema = z.object({
	topic: z.enum(FEEDBACK_TOPICS),
	rating: z.number().int().min(1).max(5),
	message: z.string().min(1, "Tell us a little more").max(2000),
});

export type FeedbackInput = z.infer<typeof feedbackSchema>;
export type FeedbackTopic = (typeof FEEDBACK_TOPICS)[number];

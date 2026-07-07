// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Validation contracts for the AWS SNS → SES webhook (app/api/webhooks/ses).
// Two layers: the SNS message envelope (signed, see lib/email/sns-signature.ts)
// and the SES event payload carried in its `Message` string. External input, so
// everything is zod-validated before we act on it.

import { z } from "zod";

/** SNS delivers one of these three envelope types. */
export const snsMessageSchema = z.object({
	Type: z.enum([
		"Notification",
		"SubscriptionConfirmation",
		"UnsubscribeConfirmation",
	]),
	MessageId: z.string(),
	TopicArn: z.string(),
	Message: z.string(),
	Timestamp: z.string(),
	Signature: z.string(),
	SignatureVersion: z.string(),
	SigningCertURL: z.string().url(),
	// Notification only.
	Subject: z.string().optional(),
	// Subscription/UnsubscribeConfirmation only — visiting it confirms the sub.
	Token: z.string().optional(),
	SubscribeURL: z.string().url().optional(),
});

export type SnsMessage = z.infer<typeof snsMessageSchema>;

const recipientSchema = z.object({
	emailAddress: z.string(),
	diagnosticCode: z.string().optional(),
});

/**
 * SES event payload (the parsed SNS `Message`). Configuration-set event
 * destinations use `eventType`; identity-level SNS notifications use
 * `notificationType` — accept either. Only Bounce/Complaint drive suppression.
 */
export const sesEventSchema = z
	.object({
		eventType: z.string().optional(),
		notificationType: z.string().optional(),
		mail: z.object({ messageId: z.string().optional() }).optional(),
		bounce: z
			.object({
				bounceType: z.string().optional(),
				bounceSubType: z.string().optional(),
				feedbackId: z.string().optional(),
				bouncedRecipients: z.array(recipientSchema).default([]),
			})
			.optional(),
		complaint: z
			.object({
				complaintFeedbackType: z.string().optional(),
				feedbackId: z.string().optional(),
				complainedRecipients: z.array(recipientSchema).default([]),
			})
			.optional(),
	})
	.transform((e) => ({ ...e, type: e.eventType ?? e.notificationType }));

export type SesEvent = z.infer<typeof sesEventSchema>;

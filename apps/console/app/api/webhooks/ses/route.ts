// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// AWS SES event webhook. The per-stream configuration sets publish bounce/
// complaint/delivery events to the `alethia-ses-events` SNS topic, which posts
// them here. We verify the SNS signature, auto-confirm the subscription, and on
// a permanent bounce or a complaint add the recipient to the suppression list
// (lib/email/suppression) so the senders stop mailing it. Idempotent — replayed
// notifications are harmless.
//
// Public endpoint: every message is signature-verified before we act, and we
// only accept messages from our own events topic.

import { recordSuppression } from "@/lib/email/suppression";
import { verifySnsSignature } from "@/lib/email/sns-signature";
import { sesEventSchema, snsMessageSchema } from "@/lib/validations/ses-event";
import type { EmailSuppressionDetail } from "@/types/database-custom.types";

// node:crypto signature verification needs the Node runtime, not edge.
export const runtime = "nodejs";

// Defense in depth: only our events topic may drive suppression.
const EXPECTED_TOPIC_SUFFIX = ":alethia-ses-events";

export async function POST(req: Request): Promise<Response> {
	const raw = await req.text();

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return new Response("invalid json", { status: 400 });
	}

	const envelope = snsMessageSchema.safeParse(parsed);
	if (!envelope.success) {
		return new Response("invalid sns message", { status: 400 });
	}
	const msg = envelope.data;

	if (!msg.TopicArn.endsWith(EXPECTED_TOPIC_SUFFIX)) {
		return new Response("unexpected topic", { status: 403 });
	}

	if (!(await verifySnsSignature(msg))) {
		return new Response("signature verification failed", { status: 403 });
	}

	// Confirm the subscription by visiting the signed SubscribeURL.
	if (msg.Type === "SubscriptionConfirmation") {
		if (msg.SubscribeURL) await fetch(msg.SubscribeURL);
		return new Response("ok", { status: 200 });
	}
	if (msg.Type === "UnsubscribeConfirmation") {
		return new Response("ok", { status: 200 });
	}

	// Notification — parse the SES event carried in Message.
	let event: ReturnType<typeof sesEventSchema.safeParse>;
	try {
		event = sesEventSchema.safeParse(JSON.parse(msg.Message));
	} catch {
		return new Response("invalid event payload", { status: 400 });
	}
	if (!event.success) {
		return new Response("invalid event payload", { status: 400 });
	}
	const e = event.data;
	const sesMessageId = e.mail?.messageId;

	// Permanent bounce → suppress each bounced recipient. Transient bounces are
	// left alone (the address may still be deliverable later).
	if (e.type === "Bounce" && e.bounce?.bounceType === "Permanent") {
		for (const r of e.bounce.bouncedRecipients) {
			const detail: EmailSuppressionDetail = {
				feedback_id: e.bounce.feedbackId,
				ses_message_id: sesMessageId,
				bounce_type: e.bounce.bounceType,
				bounce_sub_type: e.bounce.bounceSubType,
				diagnostic: r.diagnosticCode,
			};
			await recordSuppression({
				email: r.emailAddress,
				reason: "bounce",
				detail,
			});
		}
	}

	// Complaint → suppress every complained recipient.
	if (e.type === "Complaint" && e.complaint) {
		for (const r of e.complaint.complainedRecipients) {
			const detail: EmailSuppressionDetail = {
				feedback_id: e.complaint.feedbackId,
				ses_message_id: sesMessageId,
				complaint_feedback_type: e.complaint.complaintFeedbackType,
			};
			await recordSuppression({
				email: r.emailAddress,
				reason: "complaint",
				detail,
			});
		}
	}

	return new Response("ok", { status: 200 });
}

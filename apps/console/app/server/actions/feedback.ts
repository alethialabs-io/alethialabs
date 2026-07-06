"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Feedback widget (hosted-only). Feedback is a message to the vendor (Alethia Labs),
// so it's emailed via SES rather than stored — a self-hosted instance's DB belongs to
// the operator, where vendor feedback would be both dead weight and undeliverable. The
// UI hides this off the hosted control plane; this action re-checks deploymentMode() as
// defense in depth.

import { headers } from "next/headers";
import { env } from "next-runtime-env";
import { auth } from "@/lib/auth";
import { deploymentMode } from "@/lib/billing/config";
import { type FeedbackInput, feedbackSchema } from "@/lib/validations/feedback";
import { FeedbackEmail, subject } from "@/emails/feedback";
import { getEmailConfig } from "@repo/email/config";
import { sendEmail } from "@repo/email/send";

/** The inbox console feedback is delivered to (override via FEEDBACK_EMAIL). */
const DEFAULT_FEEDBACK_EMAIL = "feedback@alethialabs.io";

/**
 * Validates and emails a console feedback submission to the team inbox. Hosted-only;
 * throws on a self-managed deployment or when there's no authenticated session. With
 * SES unconfigured (local/dev) sendEmail() logs instead of sending.
 */
export async function submitFeedback(
	input: FeedbackInput,
): Promise<{ ok: true }> {
	if (deploymentMode() !== "hosted") {
		throw new Error("Feedback is only available on the hosted service");
	}

	const session = await auth.api.getSession({ headers: await headers() });
	if (!session?.user) throw new Error("Unauthorized");

	const data = feedbackSchema.parse(input);

	await sendEmail({
		from: getEmailConfig().from.general,
		to: env("FEEDBACK_EMAIL") || DEFAULT_FEEDBACK_EMAIL,
		subject: subject(data.topic),
		react: FeedbackEmail({ ...data, fromEmail: session.user.email }),
		devLog: `${data.topic} ${data.rating}/5 from ${session.user.email}`,
	});

	return { ok: true };
}

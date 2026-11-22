"use server";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Feedback widget (hosted-only). Feedback is a message to the vendor (Alethia Labs),
// so it's emailed via SES rather than stored — a self-hosted instance's DB belongs to
// the operator, where vendor feedback would be both dead weight and undeliverable. The
// UI hides this off the hosted control plane; this action re-checks deploymentMode() as
// defense in depth.
//
// It runs through the mutation contract (`defineAction`, R6 G-27): the dialog gets a result it
// can route — a validation failure under its field, an ended session to the session-ended dialog,
// anything unexpected as one toast with a reference — instead of a throw it could only catch whole.

import { headers } from "next/headers";
import { env } from "next-runtime-env";
import { auth } from "@/lib/auth";
import { UnauthorizedError } from "@/lib/auth/errors";
import { defineAction } from "@/lib/actions/define-action";
import { ActionRefusal, type ActionResult } from "@/lib/actions/result";
import { deploymentMode } from "@/lib/billing/config";
import { type FeedbackInput, feedbackSchema } from "@/lib/validations/feedback";
import { FeedbackEmail, subject } from "@/emails/feedback";
import { getEmailConfig } from "@repo/email/config";
import { sendEmail } from "@repo/email/send";

/** The inbox console feedback is delivered to (override via FEEDBACK_EMAIL). */
const DEFAULT_FEEDBACK_EMAIL = "feedback@alethialabs.io";

/** The refusal a self-managed deployment answers with: there is no vendor inbox to send to. */
const NOT_HOSTED_MESSAGE = "Feedback is only available on the hosted service.";

/**
 * Validates and emails a console feedback submission to the team inbox. Hosted-only: a
 * self-managed deployment answers `not-found`, and a request with no session `unauthenticated`,
 * both before any email is sent. With SES unconfigured (local/dev) sendEmail() logs instead of
 * sending.
 */
export async function submitFeedback(input: FeedbackInput): Promise<ActionResult<null>> {
	return defineAction({
		input: feedbackSchema,
		run: async ({ input: data }) => {
			if (deploymentMode() !== "hosted") {
				throw new ActionRefusal("not-found", NOT_HOSTED_MESSAGE);
			}

			const session = await auth.api.getSession({ headers: await headers() });
			if (!session?.user) throw new UnauthorizedError();

			await sendEmail({
				from: getEmailConfig().from.general,
				to: env("FEEDBACK_EMAIL") || DEFAULT_FEEDBACK_EMAIL,
				subject: subject(data.topic),
				react: FeedbackEmail({ ...data, fromEmail: session.user.email }),
				devLog: `${data.topic} ${data.rating}/5 from ${session.user.email}`,
			});
			return null;
		},
	})(input);
}

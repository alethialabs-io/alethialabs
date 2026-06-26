// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Email channel. Reuses the SES product stream (lib/email/send.ts) + the alert
// react-email template; recipients are non-secret (channel.config.recipients). With
// no SES configured, sendEmail() logs instead of sending so self-hosters work
// zero-setup. Event type → human label comes from the events util.

import type { AlertEventContext } from "@/types/database-custom.types";
import { AlertEmail } from "@/emails/alert";
import { getEmailConfig } from "@repo/email/config";
import type { AlertChannel } from "@/lib/db/schema";
import { sendEmail } from "@repo/email/send";
import type { ChannelSender } from "./types";
import { TEST_CONTEXT } from "./types";

/** Returns the configured recipients, throwing if none are set. */
function recipients(channel: AlertChannel): string[] {
	const list = channel.config.recipients ?? [];
	if (list.length === 0) {
		throw new Error("email channel has no recipients configured");
	}
	return list;
}

/**
 * Sends the alert email to every recipient. `eventLabel` is derived from the context
 * when it carries an event type indirectly via the title; for the generic path we
 * label by severity, and emit.ts passes a context whose title already names the event.
 */
async function send(
	channel: AlertChannel,
	context: AlertEventContext,
): Promise<void> {
	const { from } = getEmailConfig();
	const eventLabel = context.title;
	const subject = `[Alethia] ${context.title}`;
	await Promise.all(
		recipients(channel).map((to) =>
			sendEmail({
				from: from.general,
				to,
				subject,
				react: AlertEmail({ context, eventLabel }),
				devLog: context.severity,
			}),
		),
	);
}

export const emailSender: ChannelSender = {
	send,
	verify: (channel) => send(channel, TEST_CONTEXT),
};

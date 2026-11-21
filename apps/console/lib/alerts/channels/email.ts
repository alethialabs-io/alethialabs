// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Email channel. Reuses the SES product stream (lib/email/send.ts) + the alert
// react-email template; recipients are non-secret (channel.config.recipients). With
// no SES configured, sendEmail() logs instead of sending so self-hosters work
// zero-setup. Event type → human label comes from the events util.

import type { AlertEventContext } from "@/types/jsonb.types";
import { AlertEmail } from "@/emails/alert";
import { getEmailConfig } from "@repo/email/config";
import { listUnsubscribeHeaders } from "@repo/email/send";
import type { AlertChannel } from "@/lib/db/schema";
import { sendGuardedEmail } from "@/lib/email/guard";
import {
	alertChannelCategory,
	oneClickUnsubscribeUrl,
	unsubscribePageUrl,
	wantsEmail,
} from "@/lib/email/preferences";
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
 * Sends the alert email to every recipient who has not muted this channel. `eventLabel` is derived
 * from the context when it carries an event type indirectly via the title; for the generic path we
 * label by severity, and emit.ts passes a context whose title already names the event.
 *
 * Each message carries its recipient's own one-click `List-Unsubscribe` (RFC 8058) and a body link
 * to the same choice, scoped to THIS channel and THIS address: muting stops one person's copy of
 * one channel, never the channel. A muted recipient is skipped silently — the channel's other
 * recipients still get it, and a channel whose every recipient muted it sends nothing.
 */
async function send(
	channel: AlertChannel,
	context: AlertEventContext,
): Promise<void> {
	const { from, configSet } = getEmailConfig();
	const eventLabel = context.title;
	const subject = `[Alethia] ${context.title}`;
	const category = alertChannelCategory(channel.id);
	await Promise.all(
		recipients(channel).map(async (to) => {
			if (!(await wantsEmail(to, category))) return;
			const claim = { email: to, category };
			await sendGuardedEmail({
				from: from.general,
				configurationSetName: configSet.general,
				to,
				subject,
				react: AlertEmail({ context, eventLabel, unsubscribeUrl: unsubscribePageUrl(claim) }),
				headers: listUnsubscribeHeaders(oneClickUnsubscribeUrl(claim)),
				devLog: context.severity,
			});
		}),
	);
}

export const emailSender: ChannelSender = {
	send,
	verify: (channel) => send(channel, TEST_CONTEXT),
};

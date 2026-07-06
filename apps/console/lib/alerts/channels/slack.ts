// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Slack incoming webhook. POSTs a Block Kit message to the channel's webhook URL
// (stored encrypted). Severity drives the leading emoji; details render as a context
// block so the message is scannable in a channel.

import type { AlertEventContext } from "@/types/jsonb.types";
import { decryptSecret } from "@/lib/crypto/secrets";
import type { AlertChannel } from "@/lib/db/schema";
import type { AlertSeverity } from "@/lib/db/schema/enums";
import type { ChannelSender } from "./types";
import { TEST_CONTEXT } from "./types";

const TIMEOUT_MS = 10_000;

const SEVERITY_EMOJI: Record<AlertSeverity, string> = {
	info: ":information_source:",
	warning: ":warning:",
	critical: ":rotating_light:",
};

/** Reads the incoming-webhook URL from the channel's encrypted secret. */
function webhookUrl(channel: AlertChannel): string {
	const secret = channel.secret ? decryptSecret(channel.secret) : {};
	if (!secret.url) throw new Error("Slack channel has no webhook URL configured");
	return secret.url;
}

/** Builds the detail "context" block lines from the populated event fields. */
function detailLines(context: AlertEventContext): string {
	const parts: string[] = [];
	if (context.actor_id) parts.push(`*actor* ${context.actor_id}`);
	if (context.action) parts.push(`*action* ${context.action}`);
	if (context.resource_type) {
		parts.push(
			`*resource* ${context.resource_type}${context.resource_id ? ` ${context.resource_id}` : ""}`,
		);
	}
	if (context.reason) parts.push(`*reason* ${context.reason}`);
	if (context.job_id) parts.push(`*job* ${context.job_id}`);
	if (context.project_id) parts.push(`*project* ${context.project_id}`);
	if (context.connector_slug) parts.push(`*connector* ${context.connector_slug}`);
	return parts.join("  ·  ");
}

async function post(
	channel: AlertChannel,
	context: AlertEventContext,
): Promise<void> {
	const emoji = SEVERITY_EMOJI[context.severity ?? "warning"] ?? ":warning:";
	const details = detailLines(context);
	const blocks: unknown[] = [
		{
			type: "section",
			text: { type: "mrkdwn", text: `${emoji} *${context.title}*` },
		},
	];
	if (context.summary) {
		blocks.push({
			type: "section",
			text: { type: "mrkdwn", text: context.summary },
		});
	}
	if (details) {
		blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: details }] });
	}
	if (context.link) {
		blocks.push({
			type: "actions",
			elements: [
				{
					type: "button",
					text: { type: "plain_text", text: "Open in console" },
					url: context.link,
				},
			],
		});
	}

	const res = await fetch(webhookUrl(channel), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text: context.title, blocks }),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!res.ok) {
		throw new Error(`Slack responded ${res.status} ${res.statusText}`);
	}
}

export const slackSender: ChannelSender = {
	send: post,
	verify: (channel) => post(channel, TEST_CONTEXT),
};

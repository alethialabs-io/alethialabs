// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Mattermost incoming webhook. Mattermost accepts the Slack-compatible `{text,
// attachments}` shape, so this mirrors the Rocket.Chat sender; severity drives the
// attachment colour.

import type { AlertEventContext } from "@/types/jsonb.types";
import { decryptSecret } from "@/lib/crypto/secrets";
import { safeFetch } from "@/lib/net/ssrf-guard";
import type { AlertChannel } from "@/lib/db/schema";
import type { AlertSeverity } from "@/lib/db/schema/enums";
import type { ChannelSender } from "./types";
import { TEST_CONTEXT } from "./types";

const TIMEOUT_MS = 10_000;

const SEVERITY_COLOR: Record<AlertSeverity, string> = {
	info: "#71717a",
	warning: "#a16207",
	critical: "#b91c1c",
};

/** Reads the incoming-webhook URL from the channel's encrypted secret. */
function webhookUrl(channel: AlertChannel): string {
	const secret = channel.secret ? decryptSecret(channel.secret) : {};
	if (!secret.url) {
		throw new Error("Mattermost channel has no webhook URL configured");
	}
	return secret.url;
}

/** Slack-style attachment fields from the populated event context. */
function fields(
	context: AlertEventContext,
): { title: string; value: string; short: boolean }[] {
	const out: { title: string; value: string; short: boolean }[] = [];
	const add = (title: string, value?: string) => {
		if (value) out.push({ title, value, short: true });
	};
	add("Actor", context.actor_id);
	add("Action", context.action);
	add(
		"Resource",
		context.resource_type
			? `${context.resource_type}${context.resource_id ? ` ${context.resource_id}` : ""}`
			: undefined,
	);
	add("Reason", context.reason);
	add("Job", context.job_id);
	add("Project", context.project_id);
	add("Connector", context.connector_slug);
	return out;
}

async function post(
	channel: AlertChannel,
	context: AlertEventContext,
): Promise<void> {
	const color = SEVERITY_COLOR[context.severity ?? "warning"] ?? "#a16207";
	const res = await safeFetch(webhookUrl(channel), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			text: `**${context.title}**`,
			attachments: [
				{
					color,
					text: context.summary ?? "",
					fields: fields(context),
					...(context.link
						? { title: "Open in console", title_link: context.link }
						: {}),
				},
			],
		}),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!res.ok) {
		throw new Error(`Mattermost responded ${res.status} ${res.statusText}`);
	}
}

export const mattermostSender: ChannelSender = {
	send: post,
	verify: (channel) => post(channel, TEST_CONTEXT),
};

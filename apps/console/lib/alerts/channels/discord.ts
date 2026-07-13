// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Discord incoming webhook. POSTs a rich embed to the channel webhook URL (stored
// encrypted); severity drives the embed colour.

import type { AlertEventContext } from "@/types/jsonb.types";
import { decryptSecret } from "@/lib/crypto/secrets";
import { safeFetch } from "@/lib/net/ssrf-guard";
import type { AlertChannel } from "@/lib/db/schema";
import type { AlertSeverity } from "@/lib/db/schema/enums";
import type { ChannelSender } from "./types";
import { TEST_CONTEXT } from "./types";

const TIMEOUT_MS = 10_000;

// Discord embed colours are integers.
const SEVERITY_COLOR: Record<AlertSeverity, number> = {
	info: 0x71717a,
	warning: 0xa16207,
	critical: 0xb91c1c,
};

/** Reads the webhook URL from the channel's encrypted secret. */
function webhookUrl(channel: AlertChannel): string {
	const secret = channel.secret ? decryptSecret(channel.secret) : {};
	if (!secret.url) throw new Error("Discord channel has no webhook URL configured");
	return secret.url;
}

/** Embed fields from the populated event context. */
function fields(
	context: AlertEventContext,
): { name: string; value: string; inline: boolean }[] {
	const out: { name: string; value: string; inline: boolean }[] = [];
	const add = (name: string, value?: string) => {
		if (value) out.push({ name, value, inline: true });
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
	const res = await safeFetch(webhookUrl(channel), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			username: "Alethia",
			embeds: [
				{
					title: context.title,
					description: context.summary ?? undefined,
					color: SEVERITY_COLOR[context.severity ?? "warning"] ?? 0xa16207,
					fields: fields(context),
					...(context.link ? { url: context.link } : {}),
				},
			],
		}),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!res.ok) {
		throw new Error(`Discord responded ${res.status} ${res.statusText}`);
	}
}

export const discordSender: ChannelSender = {
	send: post,
	verify: (channel) => post(channel, TEST_CONTEXT),
};

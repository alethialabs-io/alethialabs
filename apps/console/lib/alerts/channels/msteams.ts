// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Microsoft Teams incoming webhook. POSTs a MessageCard to the channel webhook URL
// (stored encrypted); severity drives the theme colour. Detail fields render as a facts
// section so the card is scannable.

import type { AlertEventContext } from "@/types/jsonb.types";
import { decryptSecret } from "@/lib/crypto/secrets";
import type { AlertChannel } from "@/lib/db/schema";
import type { AlertSeverity } from "@/lib/db/schema/enums";
import type { ChannelSender } from "./types";
import { TEST_CONTEXT } from "./types";

const TIMEOUT_MS = 10_000;

// MessageCard themeColor is a hex string without the leading '#'.
const SEVERITY_COLOR: Record<AlertSeverity, string> = {
	info: "71717A",
	warning: "A16207",
	critical: "B91C1C",
};

/** Reads the incoming-webhook URL from the channel's encrypted secret. */
function webhookUrl(channel: AlertChannel): string {
	const secret = channel.secret ? decryptSecret(channel.secret) : {};
	if (!secret.url) {
		throw new Error("Microsoft Teams channel has no webhook URL configured");
	}
	return secret.url;
}

/** MessageCard facts from the populated event context. */
function facts(
	context: AlertEventContext,
): { name: string; value: string }[] {
	const out: { name: string; value: string }[] = [];
	const add = (name: string, value?: string) => {
		if (value) out.push({ name, value });
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
	const body: Record<string, unknown> = {
		"@type": "MessageCard",
		"@context": "http://schema.org/extensions",
		themeColor: SEVERITY_COLOR[context.severity ?? "warning"] ?? "A16207",
		summary: context.title,
		title: context.title,
		text: context.summary ?? "",
		sections: [{ facts: facts(context) }],
	};
	if (context.link) {
		body.potentialAction = [
			{
				"@type": "OpenUri",
				name: "Open in console",
				targets: [{ os: "default", uri: context.link }],
			},
		];
	}
	const res = await fetch(webhookUrl(channel), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!res.ok) {
		throw new Error(`Microsoft Teams responded ${res.status} ${res.statusText}`);
	}
}

export const msteamsSender: ChannelSender = {
	send: post,
	verify: (channel) => post(channel, TEST_CONTEXT),
};

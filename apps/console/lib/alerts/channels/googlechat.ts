// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Google Chat incoming webhook. POSTs a simple formatted text message to the space
// webhook URL (stored encrypted). Google Chat supports basic *bold* markup.

import type { AlertEventContext } from "@/types/jsonb.types";
import { decryptSecret } from "@/lib/crypto/secrets";
import { safeFetch } from "@/lib/net/ssrf-guard";
import type { AlertChannel } from "@/lib/db/schema";
import type { ChannelSender } from "./types";
import { TEST_CONTEXT } from "./types";

const TIMEOUT_MS = 10_000;

/** Reads the space webhook URL from the channel's encrypted secret. */
function webhookUrl(channel: AlertChannel): string {
	const secret = channel.secret ? decryptSecret(channel.secret) : {};
	if (!secret.url) {
		throw new Error("Google Chat channel has no webhook URL configured");
	}
	return secret.url;
}

/** A compact text body: bold title, summary, then key/value detail lines. */
function text(context: AlertEventContext): string {
	const lines = [`*${context.title}*`];
	if (context.summary) lines.push(context.summary);
	const detail: string[] = [];
	const add = (label: string, value?: string) => {
		if (value) detail.push(`${label}: ${value}`);
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
	if (detail.length) lines.push(detail.join("  ·  "));
	if (context.link) lines.push(context.link);
	return lines.join("\n");
}

async function post(
	channel: AlertChannel,
	context: AlertEventContext,
): Promise<void> {
	const res = await safeFetch(webhookUrl(channel), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text: text(context) }),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!res.ok) {
		throw new Error(`Google Chat responded ${res.status} ${res.statusText}`);
	}
}

export const googlechatSender: ChannelSender = {
	send: post,
	verify: (channel) => post(channel, TEST_CONTEXT),
};

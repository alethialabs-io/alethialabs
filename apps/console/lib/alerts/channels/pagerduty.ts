// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// PagerDuty (Events API v2). Triggers an incident via the integration routing key
// (stored encrypted, no URL). verify() triggers then immediately resolves the same
// dedup_key so a test never leaves an open incident or pages the on-call.

import type { AlertEventContext } from "@/types/database-custom.types";
import { decryptSecret } from "@/lib/crypto/secrets";
import type { AlertChannel } from "@/lib/db/schema";
import type { AlertSeverity } from "@/lib/db/schema/enums";
import type { ChannelSender } from "./types";
import { TEST_CONTEXT } from "./types";

const ENDPOINT = "https://events.pagerduty.com/v2/enqueue";
const TIMEOUT_MS = 10_000;

// PagerDuty severities: critical | error | warning | info.
const SEVERITY_MAP: Record<AlertSeverity, string> = {
	info: "info",
	warning: "warning",
	critical: "critical",
};

/** Reads the integration routing key from the channel's encrypted secret. */
function routingKey(channel: AlertChannel): string {
	const secret = channel.secret ? decryptSecret(channel.secret) : {};
	if (!secret.routingKey) {
		throw new Error("PagerDuty channel has no routing key configured");
	}
	return secret.routingKey;
}

/** A stable dedup key so repeats of the same event collapse into one incident. */
function dedupKey(context: AlertEventContext): string {
	const subject = context.resource_id ?? context.job_id ?? context.title;
	return `alethia:${context.resource_type ?? "alert"}:${subject}`;
}

async function enqueue(
	routing_key: string,
	event_action: "trigger" | "resolve",
	dedup_key: string,
	payload?: Record<string, unknown>,
): Promise<void> {
	const res = await fetch(ENDPOINT, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			routing_key,
			event_action,
			dedup_key,
			...(payload ? { payload } : {}),
		}),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!res.ok) {
		throw new Error(`PagerDuty responded ${res.status} ${res.statusText}`);
	}
}

async function send(
	channel: AlertChannel,
	context: AlertEventContext,
): Promise<void> {
	await enqueue(routingKey(channel), "trigger", dedupKey(context), {
		summary: context.title,
		severity: SEVERITY_MAP[context.severity ?? "warning"] ?? "warning",
		source: "Alethia",
		custom_details: {
			...(context.summary ? { summary: context.summary } : {}),
			...(context.actor_id ? { actor: context.actor_id } : {}),
			...(context.action ? { action: context.action } : {}),
			...(context.resource_type
				? { resource_type: context.resource_type }
				: {}),
			...(context.resource_id ? { resource_id: context.resource_id } : {}),
			...(context.reason ? { reason: context.reason } : {}),
			...(context.link ? { link: context.link } : {}),
		},
	});
}

async function verify(channel: AlertChannel): Promise<void> {
	const key = routingKey(channel);
	const dedup = "alethia:verification";
	await enqueue(key, "trigger", dedup, {
		summary: TEST_CONTEXT.title,
		severity: "info",
		source: "Alethia",
	});
	// Resolve immediately so the test doesn't leave an open incident.
	await enqueue(key, "resolve", dedup);
}

export const pagerdutySender: ChannelSender = { send, verify };

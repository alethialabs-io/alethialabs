// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Generic outbound webhook. POSTs the event as JSON and, when a signing secret is
// configured, signs the body with `X-Alethia-Signature: sha256=HMAC(secret, body)`
// — the outbound mirror of the inbound Stripe verification in app/api/webhooks.

import { createHmac } from "node:crypto";
import type { AlertEventContext } from "@/types/jsonb.types";
import { decryptSecret } from "@/lib/crypto/secrets";
import { safeFetch } from "@/lib/net/ssrf-guard";
import type { AlertChannel } from "@/lib/db/schema";
import type { ChannelSender } from "./types";
import { TEST_CONTEXT } from "./types";

const TIMEOUT_MS = 10_000;

/** Reads {url, signingSecret?} from the channel's encrypted secret. */
function endpoint(channel: AlertChannel): {
	url: string;
	signingSecret?: string;
} {
	const secret = channel.secret ? decryptSecret(channel.secret) : {};
	if (!secret.url) throw new Error("webhook channel has no URL configured");
	return { url: secret.url, signingSecret: secret.signingSecret };
}

async function post(
	channel: AlertChannel,
	context: AlertEventContext,
): Promise<void> {
	const { url, signingSecret } = endpoint(channel);
	const body = JSON.stringify({
		channel: channel.name,
		event: context,
		sent_at: new Date().toISOString(),
	});
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"user-agent": "Alethia-Alerts/1",
	};
	if (signingSecret) {
		const sig = createHmac("sha256", signingSecret).update(body).digest("hex");
		headers["X-Alethia-Signature"] = `sha256=${sig}`;
	}
	const res = await safeFetch(url, {
		method: "POST",
		headers,
		body,
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!res.ok) {
		throw new Error(`webhook responded ${res.status} ${res.statusText}`);
	}
}

export const webhookSender: ChannelSender = {
	send: post,
	verify: (channel) => post(channel, TEST_CONTEXT),
};

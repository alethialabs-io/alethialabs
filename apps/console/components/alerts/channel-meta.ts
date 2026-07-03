// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Display + input metadata for each alert-channel transport (the DB enum
// `alert_channel_type`). `credential` tells the forms which input to render and how the
// destination is stored: a URL secret, email recipients, or a PagerDuty routing key.

import type { AlertChannelType } from "@/lib/db/schema/enums";

/** How a transport's destination is supplied/stored. */
export type ChannelCredential = "url" | "email" | "routingKey";

export interface ChannelTypeMeta {
	/** 2–3 char mono fallback label. */
	mono: string;
	name: string;
	transport: string;
	desc: string;
	/** Destination placeholder (URL / address / key). */
	placeholder: string;
	credential: ChannelCredential;
}

export const CHANNEL_TYPE_META: Record<AlertChannelType, ChannelTypeMeta> = {
	slack: {
		mono: "SLK",
		name: "Slack",
		transport: "Incoming webhook",
		desc: "Post alerts into a Slack channel via an incoming-webhook URL.",
		placeholder: "https://hooks.slack.com/services/…",
		credential: "url",
	},
	email: {
		mono: "EML",
		name: "Email",
		transport: "SES relay",
		desc: "Deliver to people or a distribution list.",
		placeholder: "alerts@acme.cloud",
		credential: "email",
	},
	webhook: {
		mono: "WH",
		name: "Webhook",
		transport: "HTTPS POST",
		desc: "Sign and POST a JSON payload to any HTTPS endpoint.",
		placeholder: "https://api.example.com/hooks/alethia",
		credential: "url",
	},
	discord: {
		mono: "DSC",
		name: "Discord",
		transport: "Webhook URL",
		desc: "Post alerts to a Discord channel via a webhook URL.",
		placeholder: "https://discord.com/api/webhooks/…",
		credential: "url",
	},
	teams: {
		mono: "TMS",
		name: "Microsoft Teams",
		transport: "Incoming webhook",
		desc: "Post adaptive-card alerts to a Microsoft Teams channel.",
		placeholder: "https://….webhook.office.com/webhookb2/…",
		credential: "url",
	},
	mattermost: {
		mono: "MM",
		name: "Mattermost",
		transport: "Incoming webhook",
		desc: "Post to a Mattermost channel via an incoming-webhook URL.",
		placeholder: "https://mattermost.example.com/hooks/…",
		credential: "url",
	},
	googlechat: {
		mono: "GC",
		name: "Google Chat",
		transport: "Webhook URL",
		desc: "Post to a Google Chat space via a webhook URL.",
		placeholder: "https://chat.googleapis.com/v1/spaces/…",
		credential: "url",
	},
	rocketchat: {
		mono: "RC",
		name: "Rocket.Chat",
		transport: "Incoming webhook",
		desc: "Post to a Rocket.Chat channel through an integration URL.",
		placeholder: "https://chat.example.com/hooks/…",
		credential: "url",
	},
	pagerduty: {
		mono: "PD",
		name: "PagerDuty",
		transport: "Events API v2",
		desc: "Trigger and resolve PagerDuty incidents via an integration routing key.",
		placeholder: "Integration routing key",
		credential: "routingKey",
	},
};

/** Order the type gallery presents the transports in. */
export const CHANNEL_TYPE_ORDER: AlertChannelType[] = [
	"slack",
	"email",
	"webhook",
	"discord",
	"teams",
	"mattermost",
	"googlechat",
	"rocketchat",
	"pagerduty",
];

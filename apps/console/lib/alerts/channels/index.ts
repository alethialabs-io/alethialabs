// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Channel sender registry — maps an alert_channel_type to its transport. Adding a
// channel (PagerDuty, Discord, …) is one new file + one entry here.

import type { AlertChannelType } from "@/lib/db/schema/enums";
import { discordSender } from "./discord";
import { emailSender } from "./email";
import { googlechatSender } from "./googlechat";
import { mattermostSender } from "./mattermost";
import { msteamsSender } from "./msteams";
import { pagerdutySender } from "./pagerduty";
import { rocketchatSender } from "./rocketchat";
import { slackSender } from "./slack";
import type { ChannelSender } from "./types";
import { webhookSender } from "./webhook";

const SENDERS: Record<AlertChannelType, ChannelSender> = {
	webhook: webhookSender,
	email: emailSender,
	slack: slackSender,
	rocketchat: rocketchatSender,
	discord: discordSender,
	teams: msteamsSender,
	mattermost: mattermostSender,
	googlechat: googlechatSender,
	pagerduty: pagerdutySender,
};

/** The sender for a channel type. */
export function getChannelSender(type: AlertChannelType): ChannelSender {
	return SENDERS[type];
}

export type { ChannelSender } from "./types";
export { TEST_CONTEXT } from "./types";

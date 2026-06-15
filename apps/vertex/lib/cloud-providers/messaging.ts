// SPDX-FileCopyrightText: 2026 Alethia OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { CloudProviderSlug } from "./registry";

interface MessagingConfig {
	queueLabel: string;
	topicLabel: string;
	supportsFifo: boolean;
	fifoLabel: string;
	visibilityTimeoutLabel: string;
}

/** Messaging service configuration per provider. */
export const MESSAGING: Record<CloudProviderSlug, MessagingConfig> = {
	aws: {
		queueLabel: "SQS Queues",
		topicLabel: "SNS Topics",
		supportsFifo: true,
		fifoLabel: "FIFO Queue",
		visibilityTimeoutLabel: "Visibility Timeout",
	},
	gcp: {
		queueLabel: "Pub/Sub Subscriptions",
		topicLabel: "Pub/Sub Topics",
		supportsFifo: false,
		fifoLabel: "Ordered Delivery",
		visibilityTimeoutLabel: "Ack Deadline",
	},
	azure: {
		queueLabel: "Service Bus Queues",
		topicLabel: "Service Bus Topics",
		supportsFifo: true,
		fifoLabel: "Session-Based Ordering",
		visibilityTimeoutLabel: "Lock Duration",
	},
};

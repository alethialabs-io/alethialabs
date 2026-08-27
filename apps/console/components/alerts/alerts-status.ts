// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Alerts → the shared grayscale status tiers. This directory grew three private status
// indicators — a `StatusDot({tone: "ok" | "idle"})` in channels-panel, an inline dot span
// in policies-panel, and a ring-shadow span in activity-panel — each re-deciding what a
// state looks like. They all say the same three things (running / waiting / stopped), so
// they resolve here onto `@repo/ui/status-badge` and are rendered by `StatusBadge`.
//
// The mapping is deliberately not `statusTier()`'s string lookup: "verified" and "paused"
// are alerts vocabulary, not the generic lifecycle words that table knows.

import type { StatusTier } from "@repo/ui/status-badge";
import type { ChannelDTO, PolicyDTO } from "@/app/server/actions/alerts";
import {
	CHANNEL_STATUS_LABEL,
	type ChannelStatusValue,
	channelStatusKey,
	DELIVERY_STATUS_LABEL,
	POLICY_STATUS_LABEL,
	policyStatusKey,
} from "@/components/alerts/alerts-query";
import type { AlertDeliveryStatus } from "@/lib/db/schema/enums";

/** Everything a `StatusBadge` needs for one row. */
export interface AlertsStatusBadge {
	status: string;
	tier: StatusTier;
	label: string;
}

/** Channel state → tier. A paused channel is inert, not merely quiet — hence `disabled`. */
const CHANNEL_TIER: Record<ChannelStatusValue, StatusTier> = {
	verified: "active",
	unverified: "idle",
	paused: "disabled",
};

/** Delivery state → tier. `dead` is a retry-exhausted failure, so it reads as one. */
const DELIVERY_TIER: Record<AlertDeliveryStatus, StatusTier> = {
	sent: "active",
	pending: "pending",
	failed: "failed",
	dead: "failed",
};

/** The badge for a channel: Verified / Not verified / Paused. */
export function channelBadge(channel: ChannelDTO): AlertsStatusBadge {
	const key = channelStatusKey(channel);
	return {
		status: key,
		tier: CHANNEL_TIER[key],
		label: CHANNEL_STATUS_LABEL[key],
	};
}

/** The badge for a policy: Enabled / Off. */
export function policyBadge(policy: PolicyDTO): AlertsStatusBadge {
	const key = policyStatusKey(policy);
	return {
		status: key,
		tier: policy.enabled ? "active" : "disabled",
		label: POLICY_STATUS_LABEL[key],
	};
}

/** The badge for one delivery attempt in the ledger. */
export function deliveryBadge(status: AlertDeliveryStatus): AlertsStatusBadge {
	return {
		status,
		tier: DELIVERY_TIER[status],
		label: DELIVERY_STATUS_LABEL[status],
	};
}

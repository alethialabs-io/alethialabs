// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { AlertEventContext } from "@/types/database-custom.types";
import type { AlertChannel } from "@/lib/db/schema";

/**
 * One delivery transport (webhook / email / Slack / RocketChat). `send` dispatches a
 * rendered event; `verify` powers the channel "Test" button (sends a synthetic event
 * so a user confirms a destination before binding rules). Both throw on failure —
 * the dispatcher maps the throw onto the delivery ledger.
 */
export interface ChannelSender {
	send(channel: AlertChannel, context: AlertEventContext): Promise<void>;
	verify(channel: AlertChannel): Promise<void>;
}

/** The synthetic payload used by the "Test" button. */
export const TEST_CONTEXT: AlertEventContext = {
	title: "Test alert from Alethia",
	summary:
		"This is a test delivery to confirm the channel is wired correctly. No action needed.",
	severity: "info",
};

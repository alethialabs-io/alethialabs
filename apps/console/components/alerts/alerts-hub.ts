// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import type { ChannelDTO, PolicyDTO } from "@/app/server/actions/alerts";
import type { AlertsSettings } from "@/lib/rpc/procedures/alerts";

/**
 * What the hub hands its panels besides their own filtered view (#6125): the settings read, plus
 * the org's policies and channels — the PRISTINE pages' rows — which the panels select and
 * cross-reference against (the open policy, a channel's "Used by", the routing picker). It replaces
 * the `AlertsBootstrap` server-action payload, so each half is now a query a write can invalidate.
 */
export interface AlertsHub extends AlertsSettings {
	policies: PolicyDTO[];
	channels: ChannelDTO[];
	/**
	 * Whether `policies` is an ANSWER. False while the policies read is pending or after it failed,
	 * when `policies` is `[]` without meaning "no policies" — so nothing may claim that none route
	 * to a channel.
	 */
	policiesKnown: boolean;
}

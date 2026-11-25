// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ConnectedAgentsSkeleton } from "@/components/settings/connected/connected-agents-skeleton";

/** Instant skeleton for the connected-agents route: the board's own pending render. */
export default function ConnectedAgentsLoading() {
	return <ConnectedAgentsSkeleton />;
}

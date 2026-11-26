// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { AgentPolicySkeleton } from "@/components/settings/agents/agent-policy-skeleton";

/** Instant skeleton for the agent policy route: the page's own pending render. */
export default function AgentPolicyLoading() {
	return <AgentPolicySkeleton />;
}

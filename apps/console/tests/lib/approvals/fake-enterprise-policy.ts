// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A stand-in for the enterprise agent policy (lib/approvals/enterprise-policy.ts) the approval tests
// register in place of `getEnterprise()?.agentPolicy`. Core must not import `ee/`, so this states the
// toggles' meaning by hand, as table 4.2 and §4.9 of the agent-surface spec write it: an organization
// that is `entitled` gets them, one that is not is answered as core. What these tests hold is the
// WIRING — that the engine asks, with which arguments, and what it does with the answer; the toggles'
// own behaviour against the licence is ee's (ee/src/agent-policy/agent-policy.test.ts).

import { vi } from "vitest";
import type { EnterpriseAgentPolicy } from "@/lib/approvals/enterprise-policy";

/** The registered policy the module mock hands out; null is a community build. */
export interface EnterpriseSlot {
	current: EnterpriseAgentPolicy | null;
}

/** A fake enterprise agent policy whose three answers are spies. */
export function fakeEnterprisePolicy(entitled: boolean) {
	const sessionApplyNeedsSecondPerson = vi.fn<EnterpriseAgentPolicy["sessionApplyNeedsSecondPerson"]>(
		async (_orgId, toggles, operation, stage) =>
			entitled && toggles.requireDifferentApprover && (operation === "destroy" || stage === "production"),
	);
	const approverRefusal = vi.fn<EnterpriseAgentPolicy["approverRefusal"]>(async (_orgId, toggles, requester, approver) =>
		entitled && toggles.requireDifferentApprover && requester === approver ? "a different approver is required" : null,
	);
	const oauthClientRefusal = vi.fn<EnterpriseAgentPolicy["oauthClientRefusal"]>(async (_orgId, toggles, clientId) => {
		const list = toggles.allowedOauthClientIds;
		if (!entitled || list === null) return null;
		return clientId !== null && list.includes(clientId) ? null : "that client is not allowed";
	});
	const policy: EnterpriseAgentPolicy = { sessionApplyNeedsSecondPerson, approverRefusal, oauthClientRefusal };
	return { policy, sessionApplyNeedsSecondPerson, approverRefusal, oauthClientRefusal };
}

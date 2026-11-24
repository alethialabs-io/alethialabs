// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The seam through which the enterprise agent-policy toggles reach the approval engine (agent
// surface §4.9, AGT-L14). Core owns the columns (`org_agent_policy.require_different_approver`,
// `allowed_oauth_client_ids`) so the migration chain does not fork by edition; the enterprise module
// (`ee/src/agent-policy/`) owns what they mean and whether the organization's licence lets them
// apply. Core never imports `ee/`: it asks `getEnterprise()` (lib/enterprise.ts, the one allowlisted
// loader) for the registered `agentPolicy` member, and with none registered — a community build, or
// an enterprise module that registers no agent policy — every question below is answered as core
// answers it: no second person, any OAuth client, self-approval allowed (decision D6).

import type { EnvironmentStage } from "@/lib/db/schema/enums";
import { getEnterprise } from "@/lib/enterprise";
import type { ApplyOperation } from "./types";

/** The enterprise columns of `org_agent_policy`, as stored. A missing row is `false` and `null`. */
export interface StoredEnterpriseToggles {
	/** "Require a different approver": the person who approves is not the person the request is for. */
	requireDifferentApprover: boolean;
	/** The OAuth client ids allowed to act as an agent in the org. `null` means any client. */
	allowedOauthClientIds: readonly string[] | null;
}

/**
 * What the enterprise module answers. Each method takes the organization and its stored toggles and
 * decides both what the toggle means and whether the organization is entitled to it; an organization
 * without the entitlement is answered as core answers (the methods' "no" value).
 */
export interface EnterpriseAgentPolicy {
	/**
	 * Whether a person's own console click to `operation` an environment of `stage` needs a second
	 * person's approval (table 4.2: "a second person if 'different approver' is on"). False is core:
	 * the click is the approval.
	 */
	sessionApplyNeedsSecondPerson(
		orgId: string,
		toggles: StoredEnterpriseToggles,
		operation: ApplyOperation,
		stage: EnvironmentStage,
	): Promise<boolean>;
	/**
	 * Why `approverUserId` may not approve a request made for `requesterUserId`, or null when they may.
	 * Null is core: a person may approve what their own agent asked (decision D6).
	 */
	approverRefusal(
		orgId: string,
		toggles: StoredEnterpriseToggles,
		requesterUserId: string,
		approverUserId: string,
	): Promise<string | null>;
	/**
	 * Why the OAuth client `clientId` may not act as an agent in the org, or null when it may. A token
	 * with no client id is `null` here. Null is core: any client.
	 */
	oauthClientRefusal(
		orgId: string,
		toggles: StoredEnterpriseToggles,
		clientId: string | null,
	): Promise<string | null>;
}

/**
 * The registered enterprise agent policy, or null when core answers alone. A failed enterprise load
 * throws, as it does from every seam: an instance configured as enterprise never silently runs its
 * approvals as community.
 */
export function enterpriseAgentPolicy(): EnterpriseAgentPolicy | null {
	return getEnterprise()?.agentPolicy ?? null;
}

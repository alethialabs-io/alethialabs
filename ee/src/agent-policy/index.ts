// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: LicenseRef-Alethia-Commercial

// The enterprise agent-policy toggles (agent surface §4.2 and §4.9, AGT-L14).
//
// Core holds the approval gate and the two safety controls (the kill switch and "agents may not apply
// to production"). The governance controls are this module's:
//
//   * "Require a different approver". The person who approves a request is never the person it was
//     made for, and a person's own console click no longer stands as the approval where table 4.2
//     says "a second person if on": a deploy to a `production` environment, and every destroy. A
//     deploy to development or staging is still the click.
//   * The OAuth client allow-list (`allowed_oauth_client_ids`). When set, only those MCP clients may
//     act as an agent in the organization; a token that names no client is refused too. `null`
//     means any client; an empty list allows none.
//
// Both are read only while the organization holds the `agentPolicy` entitlement — from the instance
// licence when one grants, else from the organization's plan (index.ts `resolveEntitlements`). An
// unlicensed instance, a licence that does not verify, has lapsed past its grace or whose
// entitlements claim does not name `agentPolicy`, and an organization whose plan does not carry it
// are all answered exactly as core answers: no second person, any client, self-approval allowed. The
// stored toggles stay as they were, so they apply again the moment the entitlement does.
//
// The columns are core's (`org_agent_policy`), so the migration chain does not fork by edition. The
// approval engine reads the row and asks the questions below through its seam
// (apps/console/lib/approvals/enterprise-policy.ts); this module imports core for types only.
//
// Not built here: "approver restriction by role" (§4.9) needs a column `org_agent_policy` does not
// have, and no migration slot is allocated for it.

import type { EnterpriseAgentPolicy, StoredEnterpriseToggles } from "@/lib/approvals/enterprise-policy";
import type { ApplyOperation } from "@/lib/approvals/types";
import type { Entitlements } from "@/lib/authz/types";
import type { EnvironmentStage } from "@/lib/db/schema/enums";

/** Resolves an organization's entitlements: the instance licence when it grants, else its plan. */
export type EntitlementResolver = (orgId: string) => Promise<Entitlements>;

/** What a self-approval is refused with while "require a different approver" applies. */
export const SELF_APPROVAL_MESSAGE =
	"This organization requires a different person to approve a request than the one it was made for.";

/**
 * Whether table 4.2 asks a second person for a person's own console click, given that "require a
 * different approver" applies: a deploy to production, and a destroy of any environment.
 */
export function secondPersonCell(operation: ApplyOperation, stage: EnvironmentStage): boolean {
	return operation === "destroy" || stage === "production";
}

/**
 * Why OAuth client `clientId` is outside `allowList`, or null when it may act. `null` allows every
 * client; a list (even an empty one) allows only the ids it names, and never a token without one.
 */
export function clientOutsideAllowList(allowList: readonly string[] | null, clientId: string | null): string | null {
	if (allowList === null) return null;
	if (clientId !== null && allowList.includes(clientId)) return null;
	return clientId === null
		? "This organization allows only listed agent clients, and this connection does not name its client. An owner can change the allowed clients in the organization's agent settings."
		: `This organization does not allow the agent client "${clientId}". An owner can add it to the allowed clients in the organization's agent settings.`;
}

/**
 * The enterprise agent policy the approval engine consults. Every answer first asks whether the
 * organization holds `agentPolicy`; without it the answer is core's. The entitlement is asked only
 * when a stored toggle would change the answer, so an organization that set nothing costs no lookup.
 */
export function agentPolicy(resolveEntitlements: EntitlementResolver): EnterpriseAgentPolicy {
	/** Whether the organization's entitlements carry the agent-policy toggles. */
	const entitled = async (orgId: string): Promise<boolean> => (await resolveEntitlements(orgId)).agentPolicy === true;

	return {
		sessionApplyNeedsSecondPerson: async (
			orgId: string,
			toggles: StoredEnterpriseToggles,
			operation: ApplyOperation,
			stage: EnvironmentStage,
		): Promise<boolean> =>
			toggles.requireDifferentApprover && secondPersonCell(operation, stage) && (await entitled(orgId)),

		approverRefusal: async (
			orgId: string,
			toggles: StoredEnterpriseToggles,
			requesterUserId: string,
			approverUserId: string,
		): Promise<string | null> =>
			toggles.requireDifferentApprover && requesterUserId === approverUserId && (await entitled(orgId))
				? SELF_APPROVAL_MESSAGE
				: null,

		oauthClientRefusal: async (
			orgId: string,
			toggles: StoredEnterpriseToggles,
			clientId: string | null,
		): Promise<string | null> => {
			const refusal = clientOutsideAllowList(toggles.allowedOauthClientIds, clientId);
			return refusal !== null && (await entitled(orgId)) ? refusal : null;
		},
	};
}

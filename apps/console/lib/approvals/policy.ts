// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Table 4.2 of the agent-surface spec, as one pure function: which credential needs what before a
// plan, a deploy or a destroy may be queued. No I/O, so the whole table is a parameterised test
// (tests/lib/approvals/policy.test.ts) and the engine (gate.ts, request.ts) reads its answer.
//
// | Credential                     | PLAN | DEPLOY, dev/staging          | DEPLOY, production        | DESTROY                 |
// |--------------------------------|------|------------------------------|---------------------------|-------------------------|
// | session                        | none | the click                    | the click                 | the click               |
// | cli_session                    | none | approval                     | approval                  | approval                |
// | agent_oauth, agent_in_app      | none | approval                     | approval; refused when    | approval; same refusal  |
// |                                |      |                              | "no agents on production" | on production           |
// | service_token                  | none | approval, or automatic when  | approval, never automatic | approval, never         |
// |                                |      | the token lists the env (D2) |                           | automatic               |
//
// The org's kill switch (`agent_access_enabled` off) refuses the two agent kinds everything here.
// A second person for a `session` click when "require a different approver" is on is the
// enterprise toggle's (AGT-L14); in core a session's click is its approval.

import type { CredentialKind } from "@/lib/authz/types";
import type { EnvironmentStage } from "@/lib/db/schema/enums";
import type { ApplyOperation } from "./types";

/** True when `credential` is an agent acting for a person (`agent_oauth`, `agent_in_app`): the org's agent policy binds those. */
function isAgentCredential(credential: CredentialKind): boolean {
	return credential === "agent_oauth" || credential === "agent_in_app";
}

/** The parts of the org's agent policy (org_agent_policy) that the table reads. */
export interface AgentPolicyToggles {
	/** The kill switch. Off refuses every agent credential. */
	agentAccessEnabled: boolean;
	/** On refuses an agent's deploy or destroy to a production environment outright. */
	agentsMayNotApplyToProduction: boolean;
}

/** What a missing org_agent_policy row means (the column defaults). */
export const DEFAULT_AGENT_POLICY: AgentPolicyToggles = {
	agentAccessEnabled: true,
	agentsMayNotApplyToProduction: false,
};

/** One cell's question. */
export interface RequirementInput {
	credential: CredentialKind;
	/** `plan` is in the table so its column is tested; the queue gate is asked only about the other two. */
	operation: "plan" | ApplyOperation;
	stage: EnvironmentStage;
	policy: AgentPolicyToggles;
	/** A service token lists this environment in `auto_approve_environment_ids`. False for every other kind. */
	tokenAutoApprovesEnvironment: boolean;
}

/** Why the policy refuses outright: no approval can change the answer. */
export type PolicyRefusal = "agent_access_disabled" | "agents_not_on_production";

/** One cell's answer. */
export type Requirement =
	/** Nothing beyond the PDP verb: a plan, or a person's own click in the console. */
	| { kind: "none" }
	/** A service token's deploy to an environment it is set to deploy without a person (decision D2). */
	| { kind: "automatic" }
	/** A decided, unexpired, unused approval bound to this plan. */
	| { kind: "approval" }
	| { kind: "refused"; reason: PolicyRefusal };

/** The answer table 4.2 gives for one credential, operation and environment stage. */
export function applyRequirement(input: RequirementInput): Requirement {
	const { credential, operation, stage, policy } = input;
	if (isAgentCredential(credential) && !policy.agentAccessEnabled) {
		return { kind: "refused", reason: "agent_access_disabled" };
	}
	if (operation === "plan") return { kind: "none" };
	const production = stage === "production";
	switch (credential) {
		case "session":
			return { kind: "none" };
		case "cli_session":
			return { kind: "approval" };
		case "agent_oauth":
		case "agent_in_app":
			if (production && policy.agentsMayNotApplyToProduction) {
				return { kind: "refused", reason: "agents_not_on_production" };
			}
			return { kind: "approval" };
		case "service_token":
			if (operation === "deploy" && !production && input.tokenAutoApprovesEnvironment) {
				return { kind: "automatic" };
			}
			return { kind: "approval" };
		default: {
			// A credential kind this table does not name needs an approval: unknown fails closed.
			const unnamed: never = credential;
			void unnamed;
			return { kind: "approval" };
		}
	}
}

/** The sentence a {@link PolicyRefusal} is shown as. */
export function policyRefusalMessage(reason: PolicyRefusal, operation: ApplyOperation): string {
	switch (reason) {
		case "agent_access_disabled":
			return "Agent access is turned off for this organization. An owner can turn it back on in the organization's agent settings.";
		case "agents_not_on_production":
			return `This organization does not let agents ${operation} production environments. A person can ${operation} it from the console.`;
	}
}

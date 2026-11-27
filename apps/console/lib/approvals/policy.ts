// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Table 4.2 of the agent-surface spec, as one pure function: which credential needs what before a
// plan, a deploy or a destroy may be queued. No I/O, so the whole table is a parameterised test
// (tests/lib/approvals/policy.test.ts) and the engine (gate.ts, request.ts) reads its answer.
//
// | Credential                | PLAN                | DEPLOY, dev/staging          | DEPLOY, production        | DESTROY                 |
// |---------------------------|---------------------|------------------------------|---------------------------|-------------------------|
// | session                   | none                | the click                    | the click                 | the click               |
// | cli_session               | none                | approval                     | approval                  | approval                |
// | agent_oauth, agent_in_app | none; refused while | approval                     | approval; refused when    | approval; same refusal  |
// |                           | agent access is off |                              | "no agents on production" | on production           |
// | service_token             | none                | approval, or automatic when  | approval, never automatic | approval, never         |
// |                           |                     | the token lists the env (D2) |                           | automatic               |
//
// The org's kill switch (`agent_access_enabled` off) refuses the two agent kinds every cell here, the
// PLAN column included, whatever approval they hold ("off means off", maintainer decision 2026-11-24,
// #7477). It refuses them more than this table: `agentAccessRefusal` below is also what the in-product
// agent's tool guard (lib/agent/kill-switch.ts) asks before every tool call, reads and design tools
// included. A connected agent is refused one step earlier: the MCP route's actor check
// (lib/ai/mcp/actor.ts) reads the same toggle and refuses the whole request, so no MCP tool runs.
// `session`, `cli_session` and `service_token` are never refused by it — unless the request said it
// was made on behalf of an agent (`onBehalfOfAgent`, a CLI request from `alethia mcp`): then the
// switch and "no agents on production" refuse it as they refuse an agent. That mark only adds
// refusals; no cell is ever answered more loosely because of it.
// A second person for a `session` click when "require a different approver" is on, and the OAuth
// client allow-list, are the enterprise toggles (AGT-L14): the queue gate asks them through
// enterprise-policy.ts after this table, never here. In core a session's click is its approval.

import type { CredentialKind } from "@/lib/authz/types";
import type { EnvironmentStage } from "@/lib/db/schema/enums";
import type { ApplyOperation } from "./types";

/** True when `credential` is an agent acting for a person (`agent_oauth`, `agent_in_app`): the org's agent policy binds those. */
export function isAgentCredential(credential: CredentialKind): boolean {
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
	/**
	 * The request said it was made on behalf of an agent (`Actor.onBehalfOfAgent`): the agent
	 * refusals apply to it whatever its credential. It only ever adds a refusal.
	 */
	onBehalfOfAgent?: boolean;
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

/**
 * The kill switch's answer for `credential`: `agent_access_disabled` when it is an agent credential
 * and the org turned agent access off, else null. It names no operation because it refuses all of
 * them: every table cell, and every agent tool (lib/agent/kill-switch.ts).
 */
export function agentAccessRefusal(
	credential: CredentialKind,
	policy: Pick<AgentPolicyToggles, "agentAccessEnabled">,
): "agent_access_disabled" | null {
	return isAgentCredential(credential) && !policy.agentAccessEnabled ? "agent_access_disabled" : null;
}

/** The sentence every refusal by the kill switch is shown as: an apply, a plan, a read or a design tool. */
export const AGENT_ACCESS_DISABLED_MESSAGE =
	"Agent access is turned off for this organization. An owner can turn it back on in the organization's agent settings.";

/** The answer table 4.2 gives for one credential, operation and environment stage. */
export function applyRequirement(input: RequirementInput): Requirement {
	const { credential, operation, stage, policy } = input;
	const killed = agentAccessRefusal(credential, policy);
	if (killed) return { kind: "refused", reason: killed };
	// A request made on behalf of an agent under a CLI credential: the agent rows' refusals first, then
	// the credential's own row. Only refusals are added here, so the mark can never loosen a cell.
	if (input.onBehalfOfAgent) {
		if (!policy.agentAccessEnabled) return { kind: "refused", reason: "agent_access_disabled" };
		if (operation !== "plan" && stage === "production" && policy.agentsMayNotApplyToProduction) {
			return { kind: "refused", reason: "agents_not_on_production" };
		}
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
			return AGENT_ACCESS_DISABLED_MESSAGE;
		case "agents_not_on_production":
			return `This organization does not let agents ${operation} production environments. A person can ${operation} it from the console.`;
	}
}

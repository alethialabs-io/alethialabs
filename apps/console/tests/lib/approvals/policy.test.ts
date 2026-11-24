// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// Table 4.2 of the agent-surface spec as a parameterised test over credential × operation × stage ×
// the org's two agent toggles × a service token's automatic-deploy list. The expected answer for each
// cell is written out below from the spec's table, independently of lib/approvals/policy.ts, and every
// combination is enumerated so a new credential kind or stage cannot fall through untested.

import { describe, expect, it } from "vitest";
import { applyRequirement, type Requirement } from "@/lib/approvals/policy";
import { CREDENTIAL_KINDS, type CredentialKind } from "@/lib/authz/types";
import type { EnvironmentStage } from "@/lib/db/schema/enums";

const OPERATIONS = ["plan", "deploy", "destroy"] as const;
const STAGES: readonly EnvironmentStage[] = ["development", "staging", "production"];
const BOOLS = [false, true] as const;

type Cell = {
	credential: CredentialKind;
	operation: (typeof OPERATIONS)[number];
	stage: EnvironmentStage;
	agentAccessEnabled: boolean;
	agentsMayNotApplyToProduction: boolean;
	tokenAutoApprovesEnvironment: boolean;
};

const NONE: Requirement = { kind: "none" };
const APPROVAL: Requirement = { kind: "approval" };
const AUTOMATIC: Requirement = { kind: "automatic" };

/** The spec's table, cell by cell. */
function expected(c: Cell): Requirement {
	const agent = c.credential === "agent_oauth" || c.credential === "agent_in_app";
	if (agent && !c.agentAccessEnabled) return { kind: "refused", reason: "agent_access_disabled" };
	if (c.operation === "plan") return NONE;
	const production = c.stage === "production";
	if (c.credential === "session") return NONE;
	if (c.credential === "cli_session") return APPROVAL;
	if (agent) {
		return production && c.agentsMayNotApplyToProduction
			? { kind: "refused", reason: "agents_not_on_production" }
			: APPROVAL;
	}
	// service_token: automatic only for a DEPLOY to a listed, non-production environment (D2).
	return c.operation === "deploy" && !production && c.tokenAutoApprovesEnvironment ? AUTOMATIC : APPROVAL;
}

const CELLS: Cell[] = CREDENTIAL_KINDS.flatMap((credential) =>
	OPERATIONS.flatMap((operation) =>
		STAGES.flatMap((stage) =>
			BOOLS.flatMap((agentAccessEnabled) =>
				BOOLS.flatMap((agentsMayNotApplyToProduction) =>
					BOOLS.map((tokenAutoApprovesEnvironment) => ({
						credential,
						operation,
						stage,
						agentAccessEnabled,
						agentsMayNotApplyToProduction,
						tokenAutoApprovesEnvironment,
					})),
				),
			),
		),
	),
);

describe("table 4.2", () => {
	it("enumerates every combination", () => {
		expect(CELLS).toHaveLength(CREDENTIAL_KINDS.length * OPERATIONS.length * STAGES.length * 8);
	});

	it.each(CELLS)(
		"$credential $operation on $stage (agents on: $agentAccessEnabled, no agents on production: $agentsMayNotApplyToProduction, token lists env: $tokenAutoApprovesEnvironment)",
		(cell) => {
			expect(
				applyRequirement({
					credential: cell.credential,
					operation: cell.operation,
					stage: cell.stage,
					policy: {
						agentAccessEnabled: cell.agentAccessEnabled,
						agentsMayNotApplyToProduction: cell.agentsMayNotApplyToProduction,
					},
					tokenAutoApprovesEnvironment: cell.tokenAutoApprovesEnvironment,
				}),
			).toEqual(expected(cell));
		},
	);
});

describe("the rules the table states in words", () => {
	const ask = (credential: CredentialKind, operation: Cell["operation"], stage: EnvironmentStage, auto = true) =>
		applyRequirement({
			credential,
			operation,
			stage,
			policy: { agentAccessEnabled: true, agentsMayNotApplyToProduction: false },
			tokenAutoApprovesEnvironment: auto,
		});

	it("never needs anything for a plan", () => {
		for (const credential of CREDENTIAL_KINDS) {
			for (const stage of STAGES) expect(ask(credential, "plan", stage)).toEqual(NONE);
		}
	});

	it("never lets anything but a session deploy or destroy without an approval, except a listed token deploy", () => {
		for (const credential of CREDENTIAL_KINDS.filter((c) => c !== "session")) {
			for (const stage of STAGES) expect(ask(credential, "destroy", stage)).toEqual(APPROVAL);
		}
		for (const credential of CREDENTIAL_KINDS.filter((c) => c !== "session" && c !== "service_token")) {
			for (const stage of STAGES) expect(ask(credential, "deploy", stage)).toEqual(APPROVAL);
		}
	});

	it("never deploys a production environment or destroys anything automatically for a service token", () => {
		expect(ask("service_token", "deploy", "production")).toEqual(APPROVAL);
		for (const stage of STAGES) expect(ask("service_token", "destroy", stage)).toEqual(APPROVAL);
	});
});

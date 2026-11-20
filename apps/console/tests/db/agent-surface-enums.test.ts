// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The agent surface's four Postgres enums (AGT-S2) restate four TS vocabularies that seam AGT-S1
// landed first: CREDENTIAL_KINDS (lib/authz/types.ts) and AGENT_SCOPES, APPLY_OPERATIONS and
// APPROVAL_STATUSES (lib/approvals/types.ts). The schema does not import them — those modules are
// app code and drizzle-kit loads the schema on its own — so nothing but this file stops the two
// copies drifting. A value added to one side only is a row the app can write and the database
// refuses, or a status the database holds that no `switch` in the app handles.
//
// Compared IN ORDER: Postgres enum order is the sort order, and a reordering is a real change.

import { describe, expect, it } from "vitest";
import {
	AGENT_SCOPES,
	APPLY_OPERATIONS,
	APPROVAL_STATUSES,
} from "@/lib/approvals/types";
import { CREDENTIAL_KINDS } from "@/lib/authz/types";
import {
	actorCredential,
	agentScope,
	applyApprovalStatus,
	approvalOperation,
} from "@/lib/db/schema";

describe("agent surface enums match the TS vocabularies", () => {
	it("actor_credential is CREDENTIAL_KINDS", () => {
		expect(actorCredential.enumValues).toEqual([...CREDENTIAL_KINDS]);
	});

	it("agent_scope is AGENT_SCOPES", () => {
		expect(agentScope.enumValues).toEqual([...AGENT_SCOPES]);
	});

	it("approval_operation is APPLY_OPERATIONS", () => {
		expect(approvalOperation.enumValues).toEqual([...APPLY_OPERATIONS]);
	});

	it("apply_approval_status is APPROVAL_STATUSES", () => {
		expect(applyApprovalStatus.enumValues).toEqual([...APPROVAL_STATUSES]);
	});
});

// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// AGT-L2-U1 (#7501) — the approvals list's filter model and its words. The default view is Waiting
// (a real, clearable selection), a cleared status is a view a link carries, and the normalized query —
// the list's key — is the same object for the same selections in any order.

import { describe, expect, it } from "vitest";
import {
	APPROVAL_STATUS,
	requestedThrough,
	requesterName,
} from "@/components/approvals/approval-vocabulary";
import {
	approvalsQueryFromUrl,
	CLEARED_APPROVALS_FILTERS,
	DEFAULT_APPROVALS_FILTERS,
	isDefaultApprovalsView,
	normalizeApprovalsQuery,
} from "@/components/approvals/approvals-query";
import { APPROVAL_STATUSES } from "@/lib/approvals/types";

describe("the filter model", () => {
	it("a bare link is the Waiting view", () => {
		expect(approvalsQueryFromUrl(new URLSearchParams(""))).toEqual({ status: ["pending"] });
		expect(isDefaultApprovalsView(DEFAULT_APPROVALS_FILTERS)).toBe(true);
	});

	it("a cleared status is carried by the link as an empty param: every request", () => {
		expect(approvalsQueryFromUrl(new URLSearchParams("status="))).toEqual({});
		expect(isDefaultApprovalsView(CLEARED_APPROVALS_FILTERS)).toBe(false);
	});

	it("equal selections build an equal key: sorted, trimmed, empties dropped", () => {
		const a = normalizeApprovalsQuery({
			search: "  pay ",
			status: ["rejected", "approved"],
			operation: [],
			credential: ["service_token", "agent_oauth"],
			environment: [],
		});
		const b = normalizeApprovalsQuery({
			search: "pay",
			status: ["approved", "rejected"],
			operation: [],
			credential: ["agent_oauth", "service_token"],
			environment: [],
		});
		expect(a).toEqual(b);
		expect(a).toEqual({ search: "pay", status: ["approved", "rejected"], credential: ["agent_oauth", "service_token"] });
	});
});

describe("the words", () => {
	it("every status has a label and an explicit tier", () => {
		for (const status of APPROVAL_STATUSES) expect(APPROVAL_STATUS[status].label).toBeTruthy();
		expect(APPROVAL_STATUS.pending.label).toBe("Waiting");
		expect(APPROVAL_STATUS.rejected.label).toBe("Denied");
		expect(APPROVAL_STATUS.superseded).toEqual({ label: "Replaced", tier: "disabled" });
		expect(APPROVAL_STATUS.consumed).toEqual({ label: "Used", tier: "active" });
	});

	it("what asked is a name, never the enum", () => {
		expect(requesterName({ requester_credential: "agent_oauth", requester_credential_name: "Claude Code" })).toBe("Claude Code");
		expect(requesterName({ requester_credential: "agent_oauth", requester_credential_name: null })).toBe("Connected agent");
		expect(requesterName({ requester_credential: "cli_session", requester_credential_name: null })).toBe("Alethia CLI");
		expect(requesterName({ requester_credential: "agent_in_app", requester_credential_name: null })).toBe("Alethia assistant");
		expect(requestedThrough({ requester_credential: "service_token", requester_credential_name: "ci-deploy" })).toEqual({
			name: "ci-deploy",
			kind: "Service token",
		});
		expect(requestedThrough({ requester_credential: "session", requester_credential_name: null })).toEqual({
			name: "Alethia console",
			kind: "Started by them, needs a second person",
		});
	});
});

// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: LicenseRef-Alethia-Commercial

// AGT-L14 — the enterprise agent-policy toggles, each on and off, for an organization that holds the
// `agentPolicy` entitlement and one that does not. The licence cells (signed, forged, narrowed,
// lapsed) are driven through `register(core)` in ../instance-edition.test.ts; here the entitlement
// resolver is a stub that answers yes or no, so each toggle's own meaning is under test.
//
// Expected values are written out by hand, never derived from the module under test.

import { describe, expect, it, vi } from "vitest";
import type { StoredEnterpriseToggles } from "@/lib/approvals/enterprise-policy";
import type { Entitlements } from "@/lib/authz/types";
import { agentPolicy, clientOutsideAllowList, SELF_APPROVAL_MESSAGE, secondPersonCell } from "./index";

/** An entitlement set with every switch off except `agentPolicy`, which is `entitled`. */
function entitlements(entitled: boolean): Entitlements {
	return {
		organizations: false,
		teams: false,
		sso: false,
		customRoles: false,
		activityExport: false,
		alerting: false,
		advancedAlerting: false,
		byoRunners: false,
		managedPools: false,
		agentPolicy: entitled,
		quotas: { maxConcurrentJobs: 2, priorityLevel: 0, includedRunnerMinutes: 200, activityRetentionDays: 7 },
	};
}

/** The policy under test, over a resolver that answers `entitled` for every organization. */
function policyFor(entitled: boolean) {
	const resolve = vi.fn(async (_orgId: string) => entitlements(entitled));
	return { policy: agentPolicy(resolve), resolve };
}

const OFF: StoredEnterpriseToggles = { requireDifferentApprover: false, allowedOauthClientIds: null };
const DIFFERENT_APPROVER: StoredEnterpriseToggles = { requireDifferentApprover: true, allowedOauthClientIds: null };
const ALLOW_LIST: StoredEnterpriseToggles = { requireDifferentApprover: false, allowedOauthClientIds: ["claude-code", "cursor"] };

describe("secondPersonCell — table 4.2's 'a second person if on' cells", () => {
	it.each([
		["deploy", "development", false],
		["deploy", "staging", false],
		["deploy", "production", true],
		["destroy", "development", true],
		["destroy", "staging", true],
		["destroy", "production", true],
	] as const)("%s to %s → %s", (operation, stage, expected) => {
		expect(secondPersonCell(operation, stage)).toBe(expected);
	});
});

describe("require a different approver — a person's own console click", () => {
	it("needs a second person for a production deploy and a destroy when on and entitled", async () => {
		const { policy } = policyFor(true);
		expect(await policy.sessionApplyNeedsSecondPerson("org", DIFFERENT_APPROVER, "deploy", "production")).toBe(true);
		expect(await policy.sessionApplyNeedsSecondPerson("org", DIFFERENT_APPROVER, "destroy", "staging")).toBe(true);
	});

	it("leaves a staging deploy to the click even when on and entitled", async () => {
		const { policy } = policyFor(true);
		expect(await policy.sessionApplyNeedsSecondPerson("org", DIFFERENT_APPROVER, "deploy", "staging")).toBe(false);
	});

	it("needs nobody when the toggle is off, and does not ask the entitlement", async () => {
		const { policy, resolve } = policyFor(true);
		expect(await policy.sessionApplyNeedsSecondPerson("org", OFF, "destroy", "production")).toBe(false);
		expect(resolve).not.toHaveBeenCalled();
	});

	it("needs nobody when the toggle is on and the organization is not entitled", async () => {
		const { policy, resolve } = policyFor(false);
		expect(await policy.sessionApplyNeedsSecondPerson("org", DIFFERENT_APPROVER, "destroy", "production")).toBe(false);
		expect(resolve).toHaveBeenCalledWith("org");
	});
});

describe("require a different approver — deciding an approval", () => {
	it("refuses the requester's own person when on and entitled", async () => {
		const { policy } = policyFor(true);
		expect(await policy.approverRefusal("org", DIFFERENT_APPROVER, "dana", "dana")).toBe(SELF_APPROVAL_MESSAGE);
	});

	it("lets a different person approve when on and entitled", async () => {
		const { policy } = policyFor(true);
		expect(await policy.approverRefusal("org", DIFFERENT_APPROVER, "dana", "sam")).toBeNull();
	});

	it("lets the requester approve when off (decision D6)", async () => {
		const { policy } = policyFor(true);
		expect(await policy.approverRefusal("org", OFF, "dana", "dana")).toBeNull();
	});

	it("lets the requester approve when on and not entitled", async () => {
		const { policy } = policyFor(false);
		expect(await policy.approverRefusal("org", DIFFERENT_APPROVER, "dana", "dana")).toBeNull();
	});
});

describe("the OAuth client allow-list", () => {
	it("allows a listed client and refuses an unlisted one when set and entitled", async () => {
		const { policy } = policyFor(true);
		expect(await policy.oauthClientRefusal("org", ALLOW_LIST, "cursor")).toBeNull();
		expect(await policy.oauthClientRefusal("org", ALLOW_LIST, "windsurf")).toBe(
			'This organization does not allow the agent client "windsurf". An owner can add it to the allowed clients in the organization\'s agent settings.',
		);
	});

	it("refuses a token that names no client when set and entitled", async () => {
		const { policy } = policyFor(true);
		expect(await policy.oauthClientRefusal("org", ALLOW_LIST, null)).toMatch(/does not name its client/);
	});

	it("refuses every client for an empty list when entitled", async () => {
		const { policy } = policyFor(true);
		const none: StoredEnterpriseToggles = { requireDifferentApprover: false, allowedOauthClientIds: [] };
		expect(await policy.oauthClientRefusal("org", none, "claude-code")).not.toBeNull();
	});

	it("allows any client when unset, and does not ask the entitlement", async () => {
		const { policy, resolve } = policyFor(true);
		expect(await policy.oauthClientRefusal("org", OFF, "windsurf")).toBeNull();
		expect(await policy.oauthClientRefusal("org", OFF, null)).toBeNull();
		expect(resolve).not.toHaveBeenCalled();
	});

	it("allows any client when set and the organization is not entitled", async () => {
		const { policy } = policyFor(false);
		expect(await policy.oauthClientRefusal("org", ALLOW_LIST, "windsurf")).toBeNull();
	});
});

describe("clientOutsideAllowList", () => {
	it("is null for a null list whatever the client", () => {
		expect(clientOutsideAllowList(null, null)).toBeNull();
		expect(clientOutsideAllowList(null, "anything")).toBeNull();
	});

	it("names the refused client", () => {
		expect(clientOutsideAllowList(["a"], "b")).toContain('"b"');
	});
});

describe("an entitlement read that fails", () => {
	it("throws rather than answering as core, so the approval engine refuses", async () => {
		const policy = agentPolicy(async () => {
			throw new Error("billing read failed");
		});
		await expect(policy.approverRefusal("org", DIFFERENT_APPROVER, "dana", "dana")).rejects.toThrow("billing read failed");
	});
});

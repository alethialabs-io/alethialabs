// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// CON-PB2 (#6827): the small sentences this batch moved into named helpers, pinned where a test can
// read them — the partial-bulk-failure message (E-12), an invitation's expiry (#6827 addition),
// the counted policy noun (C-29) and the Create role reason (E-09).

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/client", () => ({ authClient: { organization: {} } }));
vi.mock("@/app/server/actions/members", () => ({ setMemberSuspended: vi.fn() }));
vi.mock("@/app/server/actions/roles", () => ({ deleteRole: vi.fn() }));

import { policyCount } from "@/components/alerts/channels-panel";
import { MANAGE_DENIED_REASON } from "@/components/errors/manage-gate";
import { bulkFailureMessage, invitationExpiry } from "@/components/settings/members/members-table";
import { createRoleReason, CUSTOM_ROLES_PLAN_REASON } from "@/components/settings/roles/roles-manager";

describe("bulkFailureMessage (R6 E-12)", () => {
	it("names the failed rows with their reasons and says they stay selected", () => {
		expect(
			bulkFailureMessage(
				[
					{ label: "Ada Lovelace", reason: "Only an owner can remove an admin" },
					{ label: "linus@example.test", reason: null },
				],
				5,
			),
		).toBe(
			"2 of 5 selected rows could not be changed: Ada Lovelace (Only an owner can remove an admin), linus@example.test. They stay selected.",
		);
	});

	it("names three and counts the rest", () => {
		const failures = ["a", "b", "c", "d", "e"].map((label) => ({ label, reason: null }));
		expect(bulkFailureMessage(failures, 6)).toBe(
			"5 of 6 selected rows could not be changed: a, b, c and 2 more. They stay selected.",
		);
	});

	it("one failure out of one", () => {
		expect(bulkFailureMessage([{ label: "a", reason: null }], 1)).toBe(
			"1 of 1 selected row could not be changed: a. It stays selected.",
		);
	});
});

describe("invitationExpiry (#6827)", () => {
	const asOf = "2026-01-04T00:00:00.000Z";

	it("a link still live expires in the future", () => {
		expect(invitationExpiry("2026-01-09T00:00:00.000Z", asOf)).toEqual({
			label: "expires in 5 days",
			expired: false,
		});
	});

	it("a link past its expiry has expired", () => {
		expect(invitationExpiry("2026-01-03T00:00:00.000Z", asOf)).toEqual({
			label: "expired 1 day ago",
			expired: true,
		});
	});
});

describe("policyCount (R6 C-29)", () => {
	it("counts one noun, never 'policy/policies'", () => {
		expect(policyCount(1)).toBe("1 policy");
		expect(policyCount(3)).toBe("3 policies");
		expect(policyCount(0)).toBe("0 policies");
	});
});

describe("createRoleReason (R6 E-09)", () => {
	it("the plan first, then the role, then nothing", () => {
		expect(createRoleReason(false, true)).toBe(CUSTOM_ROLES_PLAN_REASON);
		expect(createRoleReason(false, false)).toBe(CUSTOM_ROLES_PLAN_REASON);
		expect(createRoleReason(true, false)).toBe(MANAGE_DENIED_REASON);
		expect(createRoleReason(true, true)).toBeNull();
	});
});
